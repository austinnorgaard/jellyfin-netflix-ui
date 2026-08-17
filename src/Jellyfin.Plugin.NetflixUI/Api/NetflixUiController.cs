using System.Net.Mime;
using System.Reflection;
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
/// </summary>
[ApiController]
[Route("NetflixUI")]
public class NetflixUiController : ControllerBase
{
    private readonly ILogger<NetflixUiController> _logger;

    public NetflixUiController(ILogger<NetflixUiController> logger)
    {
        _logger = logger;
    }

    [HttpGet("netflix-ui.js")]
    [AllowAnonymous]
    [Produces("application/javascript")]
    public ActionResult GetScript()
    {
        string? js = ReadResource("Web.netflix-ui.js");

        if (js is null)
        {
            return NotFound();
        }

        // Hand the browser the user's settings so the script doesn't need a
        // separate authenticated round-trip before it can render anything.
        var config = Plugin.Instance?.Configuration;

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

        return Content(prelude + js, "application/javascript", Encoding.UTF8);
    }

    [HttpGet("netflix-ui.css")]
    [AllowAnonymous]
    [Produces("text/css")]
    public ActionResult GetStylesheet()
    {
        string? css = ReadResource("Web.netflix-ui.css");

        if (css is null)
        {
            return NotFound();
        }

        string accent = Plugin.Instance?.Configuration.AccentColor ?? "#e50914";

        // Let the configured accent win over the stylesheet default.
        css = ":root{--nf-red:" + accent + ";}\n" + css;

        return Content(css, "text/css", Encoding.UTF8);
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
