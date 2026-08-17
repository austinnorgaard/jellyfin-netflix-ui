using System.Reflection;
using System.Text.Json;

namespace Jellyfin.Plugin.NetflixUI;

/// <summary>
/// Injects the Netflix UI stylesheet and script into jellyfin-web's index.html.
///
/// Invoked by reflection from the File Transformation plugin, so the method must
/// stay <c>public static</c> and keep this exact name.
///
/// ⚠️ The parameter MUST be <see cref="object"/>.
///
/// File Transformation hands us a Newtonsoft <c>JObject</c>. Declaring a typed
/// DTO here does not bind, and a callback that fails to bind stalls the request
/// - jellyfin-web then never loads at all, failing with
/// "The request was canceled due to the configured HttpClient.Timeout of 100
/// seconds elapsing" on GET /web/. Taking <c>object</c> always binds, and we
/// read the payload without ever referencing Newtonsoft's types (our copy would
/// be a different type anyway - each plugin gets its own AssemblyLoadContext).
/// </summary>
public static class IndexHtmlTransformer
{
    private const string Marker = "<!-- netflix-ui -->";

    /// <summary>
    /// Returns index.html with our assets appended just before &lt;/body&gt;.
    /// On ANY failure the original contents are returned unmodified, so a broken
    /// transform degrades to plain Jellyfin rather than taking the web client down.
    /// </summary>
    public static string Transform(object payload)
    {
        string contents = string.Empty;

        try
        {
            contents = ExtractContents(payload);

            if (string.IsNullOrEmpty(contents))
            {
                return contents;
            }

            // File Transformation can invoke a callback more than once per served
            // file (and other plugins chain onto the same document) - make this
            // idempotent or the script registers repeatedly and handlers double-fire.
            if (contents.Contains(Marker, StringComparison.Ordinal))
            {
                return contents;
            }

            string injection =
                Marker + "\n" +
                "<link rel=\"stylesheet\" href=\"/NetflixUI/netflix-ui.css\">\n" +
                "<script src=\"/NetflixUI/netflix-ui.js\" defer></script>\n";

            int bodyClose = contents.LastIndexOf("</body>", StringComparison.OrdinalIgnoreCase);

            return bodyClose < 0
                ? contents + injection          // unexpected document shape
                : contents.Insert(bodyClose, injection);
        }
        catch
        {
            // Never let a theme break page delivery. Whatever we managed to read
            // goes back untouched.
            return contents;
        }
    }

    /// <summary>
    /// Pull the "contents" string out of the payload without binding to Newtonsoft.
    /// Tries the JObject string indexer first, then falls back to serialising the
    /// whole object and reading the property out of the JSON.
    /// </summary>
    private static string ExtractContents(object payload)
    {
        if (payload is null)
        {
            return string.Empty;
        }

        // Fast path: a plain string was handed to us.
        if (payload is string direct)
        {
            return direct;
        }

        Type type = payload.GetType();

        // JObject exposes a string indexer returning JToken; ToString() on that
        // token gives the raw value.
        try
        {
            PropertyInfo? indexer = type.GetProperty("Item", new[] { typeof(string) });
            object? token = indexer?.GetValue(payload, new object[] { "contents" });

            if (token is not null)
            {
                string? value = token.ToString();

                if (!string.IsNullOrEmpty(value))
                {
                    return value;
                }
            }
        }
        catch
        {
            // fall through to the JSON route
        }

        // Fallback: JObject.ToString() emits JSON, so parse it with System.Text.Json.
        try
        {
            string? json = payload.ToString();

            if (!string.IsNullOrEmpty(json))
            {
                using JsonDocument doc = JsonDocument.Parse(json);

                if (doc.RootElement.TryGetProperty("contents", out JsonElement el) &&
                    el.ValueKind == JsonValueKind.String)
                {
                    return el.GetString() ?? string.Empty;
                }
            }
        }
        catch
        {
            // give up below
        }

        return string.Empty;
    }
}
