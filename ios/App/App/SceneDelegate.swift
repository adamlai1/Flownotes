import UIKit
import Capacitor

// ── Share Extension hand-off ─────────────────────────────────────────────────
//
// These two classes live in this file (already a compile source of the App
// target) rather than their own files on purpose: it keeps main buildable
// without any "add files to target" step in Xcode. See
// ios/SHARE_EXTENSION_SETUP.md for the extension-target side.

/// Bridge for the Share Extension hand-off. The extension
/// (share-extension-src/ShareViewController.swift) writes the shared text into
/// App Group UserDefaults; the web layer (src/lib/shareImport.js) calls take()
/// to collect it.
///
/// take() is read-AND-clear in one call: whether or not the payload gets used,
/// it is gone from the App Group afterwards, so stale text can never leak into
/// a later import.
@objc(SharedImportPlugin)
public class SharedImportPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "SharedImportPlugin"
    public let jsName = "SharedImport"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "take", returnType: CAPPluginReturnPromise)
    ]

    // Must match share-extension-src/ShareViewController.swift.
    private static let appGroupId = "group.com.adamlai.flownotes"
    private static let textKey = "shareText"
    private static let tsKey = "shareTs"

    @objc func take(_ call: CAPPluginCall) {
        guard let defaults = UserDefaults(suiteName: Self.appGroupId) else {
            call.resolve([:])
            return
        }
        let text = defaults.string(forKey: Self.textKey)
        let ts = defaults.double(forKey: Self.tsKey)
        defaults.removeObject(forKey: Self.textKey)
        defaults.removeObject(forKey: Self.tsKey)

        if let text = text, !text.isEmpty {
            call.resolve(["text": text, "ts": ts])
        } else {
            call.resolve([:])
        }
    }
}

/// The app's bridge view controller. Exists only to register plugins defined
/// in the app project itself (Capacitor auto-discovers packaged plugins, but
/// local ones must be registered by hand since Capacitor 6).
class MainViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(SharedImportPlugin())
    }
}

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        // MainViewController (not plain CAPBridgeViewController) so locally
        // defined plugins — SharedImportPlugin — get registered on the bridge.
        window?.rootViewController = MainViewController()
        window?.makeKeyAndVisible()

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}
