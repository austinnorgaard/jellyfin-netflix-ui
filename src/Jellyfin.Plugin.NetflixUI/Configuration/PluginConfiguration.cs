using MediaBrowser.Model.Plugins;

namespace Jellyfin.Plugin.NetflixUI.Configuration;

public class PluginConfiguration : BasePluginConfiguration
{
    /// <summary>
    /// Master switch. When false the script no-ops, so you can turn the theme
    /// off without uninstalling (useful when debugging whether it broke something).
    /// </summary>
    public bool Enabled { get; set; } = true;

    /// <summary>
    /// Netflix's signature interaction: hovering a card scales it up and expands
    /// it into a mini-modal with metadata and Play / + / info buttons.
    /// </summary>
    public bool HoverPreview { get; set; } = true;

    /// <summary>Milliseconds to hover before the mini-modal expands. Netflix uses ~400ms.</summary>
    public int HoverDelayMs { get; set; } = 400;

    /// <summary>Arrow buttons that page a row a full viewport at a time.</summary>
    public bool RowCarousels { get; set; } = true;

    /// <summary>Big outlined rank numerals on the first N items of "Top" rows.</summary>
    public bool TopTenBadges { get; set; } = true;

    /// <summary>Open items in a Netflix-style overlay instead of navigating to the detail page.</summary>
    public bool DetailModal { get; set; } = true;

    /// <summary>
    /// Play a muted video preview in the hover panel, like Netflix.
    ///
    /// OFF by default and deliberately so: it only ever uses a LOCAL trailer,
    /// because streaming the feature itself would start a transcode on every
    /// card hover, which on a modest server is a self-inflicted DoS. Titles
    /// with no local trailer simply keep the still image.
    /// </summary>
    public bool HoverTrailers { get; set; }

    /// <summary>
    /// Fetch Netflix Sans at runtime rather than shipping it.
    ///
    /// It is a proprietary Dalton Maag typeface licensed to Netflix, so it is
    /// deliberately NOT committed to this repository. With this off (the default
    /// for anyone but the original author) the theme falls back to Inter /
    /// Helvetica Neue, which is visually very close.
    /// </summary>
    public bool FetchNetflixSans { get; set; }

    /// <summary>Accent colour. Netflix red by default.</summary>
    public string AccentColor { get; set; } = "#e50914";
}
