using System.Text.Json;
using System.Text.Json.Serialization;

namespace Jellyfin.Plugin.NetflixUI;

/// <summary>
/// Payload handed to us by File Transformation. It arrives as JSON shaped
/// <c>{ "contents": "..." }</c>, so this is deliberately a plain DTO.
/// </summary>
public class TransformationPayload
{
    [JsonPropertyName("contents")]
    public string Contents { get; set; } = string.Empty;
}

/// <summary>
/// Injects the Netflix UI stylesheet and script into jellyfin-web's index.html.
/// Invoked by reflection, so the method must stay <c>public static</c> and keep this name.
/// </summary>
public static class IndexHtmlTransformer
{
    private const string Marker = "<!-- netflix-ui -->";

    /// <summary>
    /// Returns index.html with our assets appended just before &lt;/body&gt;.
    /// </summary>
    public static string Transform(TransformationPayload payload)
    {
        string contents = payload.Contents;

        if (string.IsNullOrEmpty(contents))
        {
            return contents;
        }

        // File Transformation can be invoked more than once per served file
        // (and other plugins chain onto the same document) - make this idempotent
        // or the script ends up registered several times and handlers double-fire.
        if (contents.Contains(Marker, StringComparison.Ordinal))
        {
            return contents;
        }

        string injection =
            Marker + "\n" +
            "<link rel=\"stylesheet\" href=\"/NetflixUI/netflix-ui.css\">\n" +
            "<script src=\"/NetflixUI/netflix-ui.js\" defer></script>\n";

        int bodyClose = contents.LastIndexOf("</body>", StringComparison.OrdinalIgnoreCase);

        if (bodyClose < 0)
        {
            // Malformed or unexpected document - append rather than silently doing nothing.
            return contents + injection;
        }

        return contents.Insert(bodyClose, injection);
    }
}
