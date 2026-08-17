using System.Globalization;
using System.Reflection;
using System.Runtime.Loader;
using System.Text.Json;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Common.Plugins;
using MediaBrowser.Model.Plugins;
using MediaBrowser.Model.Serialization;
using Microsoft.Extensions.Logging;
using Jellyfin.Plugin.NetflixUI.Configuration;

namespace Jellyfin.Plugin.NetflixUI;

/// <summary>
/// Netflix UI - turns the Jellyfin web client into a Netflix-alike.
///
/// The visual layer is CSS, but the parts that actually make it *feel* like
/// Netflix (hover-preview cards that expand into a mini-modal, row carousels,
/// Top 10 badges, the detail overlay) need DOM work, so we inject a script.
///
/// Jellyfin has no supported hook for modifying jellyfin-web, so we register
/// with IAmParadox27's File Transformation plugin, which is the community
/// standard for this and is what home-sections / plugin-pages use.
/// </summary>
public class Plugin : BasePlugin<PluginConfiguration>, IHasWebPages
{
    private readonly ILogger<Plugin> _logger;

    public Plugin(
        IApplicationPaths applicationPaths,
        IXmlSerializer xmlSerializer,
        ILogger<Plugin> logger)
        : base(applicationPaths, xmlSerializer)
    {
        Instance = this;
        _logger = logger;

        // Assets are memoised with an ETag, so a settings change must drop that
        // cache or a new accent colour / toggle would not take effect until the
        // next server restart.
        ConfigurationChanged += (_, _) => Api.NetflixUiController.InvalidateCache();

        RegisterFileTransformation();
    }

    public override string Name => "Netflix UI";

    public override Guid Id => Guid.Parse("58c4919a-9515-46ce-a114-c0336d3f830f");

    public override string Description =>
        "Restyles Jellyfin as a Netflix-alike: hover-preview cards, expanding mini-modal, row carousels, Top 10 badges.";

    public static Plugin? Instance { get; private set; }

    public IEnumerable<PluginPageInfo> GetPages()
    {
        yield return new PluginPageInfo
        {
            Name = Name,
            EmbeddedResourcePath = GetType().Namespace + ".Configuration.configPage.html"
        };
    }

    /// <summary>
    /// Ask File Transformation to call us back whenever index.html is served.
    ///
    /// This has to go through reflection: Jellyfin loads each plugin into its own
    /// AssemblyLoadContext, so a direct project reference would resolve to a
    /// different (unloaded) copy of the type at runtime. Documented approach.
    /// </summary>
    private void RegisterFileTransformation()
    {
        try
        {
            Assembly? fileTransformationAssembly = AssemblyLoadContext.All
                .SelectMany(x => x.Assemblies)
                .FirstOrDefault(x => x.FullName?.Contains(".FileTransformation", StringComparison.Ordinal) ?? false);

            if (fileTransformationAssembly is null)
            {
                _logger.LogWarning(
                    "Netflix UI: the File Transformation plugin was not found. " +
                    "Install it from https://www.iamparadox.dev/jellyfin/plugins/manifest.json and restart - " +
                    "without it the Netflix UI cannot be injected into the web client.");
                return;
            }

            Type? pluginInterfaceType = fileTransformationAssembly
                .GetType("Jellyfin.Plugin.FileTransformation.PluginInterface");

            if (pluginInterfaceType is null)
            {
                _logger.LogWarning("Netflix UI: File Transformation is present but PluginInterface was not found. Version mismatch?");
                return;
            }

            MethodInfo? register = pluginInterfaceType.GetMethod("RegisterTransformation");

            if (register is null)
            {
                _logger.LogWarning("Netflix UI: File Transformation has no RegisterTransformation method. Version mismatch?");
                return;
            }

            // Matches index.html regardless of the hashed asset path jellyfin-web uses.
            string json = JsonSerializer.Serialize(new Dictionary<string, object?>
            {
                ["id"] = Id.ToString(),
                ["fileNamePattern"] = "index.html",
                ["callbackAssembly"] = GetType().Assembly.FullName,
                ["callbackClass"] = typeof(IndexHtmlTransformer).FullName,
                ["callbackMethod"] = nameof(IndexHtmlTransformer.Transform)
            });

            // RegisterTransformation takes a Newtonsoft JObject, not System.Text.Json.
            // Do NOT add a Newtonsoft PackageReference to satisfy that: Jellyfin loads
            // each plugin into its own AssemblyLoadContext, so our Newtonsoft would be
            // a *different* JObject type and the invoke would fail with exactly the
            // same ArgumentException. Instead, take the parameter type straight off
            // the method signature - that is by definition the instance File
            // Transformation itself is bound to - and use its own Parse().
            Type payloadType = register.GetParameters()[0].ParameterType;

            MethodInfo? parse = payloadType.GetMethod(
                "Parse",
                BindingFlags.Public | BindingFlags.Static,
                binder: null,
                types: new[] { typeof(string) },
                modifiers: null);

            if (parse is null)
            {
                _logger.LogWarning(
                    "Netflix UI: could not find a static Parse(string) on {Type}; cannot build the registration payload.",
                    payloadType.FullName);
                return;
            }

            object? payload = parse.Invoke(null, new object?[] { json });
            register.Invoke(null, new[] { payload });

            _logger.LogInformation("Netflix UI: registered index.html transformation with File Transformation.");
        }
        catch (Exception ex)
        {
            // Never let a theme plugin take the server down on startup.
            _logger.LogError(ex, "Netflix UI: failed to register its file transformation. The UI will be unmodified.");
        }
    }
}
