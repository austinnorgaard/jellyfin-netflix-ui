using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.NetflixUI.Api;

/// <summary>
/// Serves the theme's web assets.
///
/// These must be reachable by an unauthenticated browser: index.html references
/// them before the user has a session (the login page is themed too), so the
/// endpoints are deliberately [AllowAnonymous]. They only ever return static
/// CSS/JS embedded in the assembly - no user data passes through here.
///
/// Everything is built once and cached in memory with a strong ETag. Previously
/// each request re-read the resource out of the assembly, re-serialised the
/// config and re-concatenated strings, and shipped no cache headers at all - so
/// every navigation re-downloaded ~44KB that never changes between restarts.
/// </summary>
[ApiController]
[Route("NetflixUI")]
public class NetflixUiController : ControllerBase
{
    private readonly ILogger<NetflixUiController> _logger;

    // Built lazily, then reused. Invalidated by RebuildCache() when settings change.
    private static readonly object CacheLock = new();
    private static CachedAsset? _script;
    private static CachedAsset? _stylesheet;

    private sealed record CachedAsset(string Body, string ETag);

    public NetflixUiController(ILogger<NetflixUiController> logger)
    {
        _logger = logger;
    }

    /// <summary>
    /// Drop the memoised assets. Called when plugin configuration is saved so a
    /// changed accent colour or toggle is reflected without restarting Jellyfin.
    /// </summary>
    public static void InvalidateCache()
    {
        lock (CacheLock)
        {
            _script = null;
            _stylesheet = null;
        }
    }

    [HttpGet("netflix-ui.js")]
    [AllowAnonymous]
    public ActionResult GetScript()
    {
        CachedAsset? asset = GetScriptAsset();

        return asset is null ? NotFound() : Send(asset, "application/javascript");
    }

    [HttpGet("netflix-ui.css")]
    [AllowAnonymous]
    public ActionResult GetStylesheet()
    {
        CachedAsset? asset = GetStylesheetAsset();

        return asset is null ? NotFound() : Send(asset, "text/css");
    }

    /// <summary>
    /// Respond with the asset, honouring If-None-Match so repeat navigations cost
    /// a 304 rather than the full payload.
    /// </summary>
    private ActionResult Send(CachedAsset asset, string contentType)
    {
        // Assets are versioned by content hash, so they may be held for a long
        // time; "must-revalidate" keeps a settings change from being sticky
        // beyond the ETag check.
        Response.Headers.CacheControl = "public, max-age=3600, must-revalidate";
        Response.Headers.ETag = asset.ETag;

        string? inm = Request.Headers.IfNoneMatch;

        if (!string.IsNullOrEmpty(inm) && inm.Contains(asset.ETag, StringComparison.Ordinal))
        {
            return StatusCode(304);
        }

        return Content(asset.Body, contentType, Encoding.UTF8);
    }

    private CachedAsset? GetScriptAsset()
    {
        lock (CacheLock)
        {
            if (_script is not null)
            {
                return _script;
            }

            string? js = ReadResource("Web.netflix-ui.js");

            if (js is null)
            {
                return null;
            }

            // Hand the browser the user's settings so the script doesn't need a
            // separate authenticated round-trip before it can render anything.
            Configuration.PluginConfiguration? config = Plugin.Instance?.Configuration;

            string prelude =
                "window.NetflixUIConfig = " + System.Text.Json.JsonSerializer.Serialize(new
                {
                    enabled = config?.Enabled ?? true,
                    hoverPreview = config?.HoverPreview ?? true,
                    hoverDelayMs = config?.HoverDelayMs ?? 400,
                    rowCarousels = config?.RowCarousels ?? true,
                    topTenBadges = config?.TopTenBadges ?? true,
                    detailModal = config?.DetailModal ?? true,
                    hoverTrailers = config?.HoverTrailers ?? false,
                    accentColor = config?.AccentColor ?? "#e50914"
                }) + ";\n";

            string body = prelude + js;
            _script = new CachedAsset(body, MakeETag(body));
            return _script;
        }
    }

    private CachedAsset? GetStylesheetAsset()
    {
        lock (CacheLock)
        {
            if (_stylesheet is not null)
            {
                return _stylesheet;
            }

            // Master switch is enforced here, because the stylesheet itself is no
            // longer gated behind a JS-applied class (see the note atop the CSS).
            if (Plugin.Instance?.Configuration.Enabled == false)
            {
                const string off = "/* Netflix UI disabled in plugin settings */";
                _stylesheet = new CachedAsset(off, MakeETag(off));
                return _stylesheet;
            }

            string? css = ReadResource("Web.netflix-ui.css");

            if (css is null)
            {
                return null;
            }

            string accent = Plugin.Instance?.Configuration.AccentColor ?? "#e50914";

            // Let the configured accent win over the stylesheet default.
            string body = ":root{--nf-red:" + accent + ";}\n" + css;
            _stylesheet = new CachedAsset(body, MakeETag(body));
            return _stylesheet;
        }
    }

    private static string MakeETag(string body)
    {
        byte[] hash = SHA256.HashData(Encoding.UTF8.GetBytes(body));
        return "\"" + Convert.ToHexString(hash, 0, 8).ToLowerInvariant() + "\"";
    }

    private string? ReadResource(string relativeName)
    {
        string resource = typeof(Plugin).Namespace + "." + relativeName;

        using Stream? stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(resource);

        if (stream is null)
        {
            _logger.LogError("Netflix UI: embedded resource {Resource} is missing from the assembly.", resource);
            return null;
        }

        using var reader = new StreamReader(stream, Encoding.UTF8);
        return reader.ReadToEnd();
    }
}
