import UIKit
import UniformTypeIdentifiers
import os.log

/// Nubble's share sheet entry. Deliberately minimal: extensions run under
/// tight memory limits, so this does nothing with the text beyond handing it
/// off — write it to App Group UserDefaults, then try to foreground Nubble so
/// the payload is collected immediately (src/lib/shareImport.js).
///
/// The launch attempt is ADDITIVE, never load-bearing. Apple provides no
/// supported way for a share extension to open its containing app; the
/// responder-chain walk below is the same unsupported pattern LocalSend and
/// others ship, and Apple has broken it once already (iOS 18 kill-switched the
/// deprecated `openURL:` selector — "Force returning false (NO)") and may
/// break it again. When it fails, the designed degradation is the original
/// save-and-switch flow: a "Saved" card, and the app collects the payload
/// from the App Group mailbox on its next foreground, by any route.
///
/// Accepts plain text and URLs only — the activation rule in Info.plist keeps
/// Nubble out of the share sheet for anything else, so images and files are
/// declined by never matching rather than half-handled here.
class ShareViewController: UIViewController {

    // Must match SharedImportPlugin in App/App/SceneDelegate.swift.
    private static let appGroupId = "group.com.adamlai.flownotes"
    private static let textKey = "shareText"
    private static let tsKey = "shareTs"

    // Must match SHARE_IMPORT_URL in src/lib/shareImport.js. The scheme is
    // registered in the App target's Info.plist (CFBundleURLTypes).
    private static let hostAppURL = "com.adamlai.flownotes://share-import"

    // Filter Console.app on this subsystem to watch the hand-off. Content is
    // never logged, only lengths.
    private static let log = Logger(subsystem: "com.adamlai.flownotes.ShareExtension", category: "share")

    // Long enough to read "Saved", short enough to not feel like a modal.
    private static let confirmationSeconds: TimeInterval = 1.5

    private var didHandle = false
    private var didComplete = false
    // Stamped when the fallback card actually appears on screen. complete()
    // reads it to guarantee the card its full display time (see complete()).
    private var cardShownAt: Date?

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .clear
        view.isOpaque = false
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        guard !didHandle else { return }
        didHandle = true
        handleShare()
    }

    private func handleShare() {
        let providers = (extensionContext?.inputItems as? [NSExtensionItem])?
            .flatMap { $0.attachments ?? [] } ?? []

        // Prefer plain text; fall back to a URL rendered as its string.
        if let provider = providers.first(where: { $0.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) }) {
            provider.loadItem(forTypeIdentifier: UTType.plainText.identifier, options: nil) { [weak self] data, _ in
                // Some hosts hand plain text over as NSData rather than NSString.
                var text = data as? String
                if text == nil, let d = data as? Data { text = String(data: d, encoding: .utf8) }
                self?.finish(with: text)
            }
        } else if let provider = providers.first(where: { $0.hasItemConformingToTypeIdentifier(UTType.url.identifier) }) {
            provider.loadItem(forTypeIdentifier: UTType.url.identifier, options: nil) { [weak self] data, _ in
                let url = data as? URL
                self?.finish(with: url?.absoluteString)
            }
        } else {
            // Activation rules should prevent this, but decline cleanly if a
            // host slips something unexpected through.
            complete()
        }
    }

    private func finish(with text: String?) {
        DispatchQueue.main.async {
            guard let text = text, !text.isEmpty else {
                Self.log.error("share produced no text; completing without write")
                self.complete()
                return
            }
            guard let defaults = UserDefaults(suiteName: Self.appGroupId) else {
                Self.log.error("App Group unavailable — capability missing on the extension target?")
                self.complete()
                return
            }

            defaults.set(text, forKey: Self.textKey)
            // Milliseconds, to compare directly against Date.now() in JS. The
            // app treats payloads older than its window as abandoned.
            defaults.set(Date().timeIntervalSince1970 * 1000, forKey: Self.tsKey)

            // Read-back verification, visible in Console.app (filter on the
            // subsystem above). Proves the write landed before we claim "Saved".
            let readback = defaults.string(forKey: Self.textKey)
            if readback == text {
                // .notice, not .info: info-level is memory-only and dies with this
                // short-lived process before Console ever sees it.
                Self.log.notice("App Group write verified: \(text.count, privacy: .public) chars")
            } else {
                Self.log.error("App Group write FAILED readback: wrote \(text.count, privacy: .public) chars, read \(readback?.count ?? -1, privacy: .public)")
            }

            // The payload is safely in the mailbox either way; now try to
            // foreground Nubble on top of it. Success: the app opens onto
            // Import and this sheet just dismisses — no card, nothing to read.
            // Failure: fall back to save-and-switch, where the card tells the
            // user the save landed and switching is on them.
            self.launchHostApp { launched in
                if launched {
                    Self.log.notice("host app launch succeeded")
                    self.complete()
                } else {
                    Self.log.notice("host app launch failed — falling back to save-and-switch")
                    self.showConfirmation()
                    // complete() defers itself until the card has had its full
                    // display time — no separate timer to race against.
                    self.complete()
                }
            }
        }
    }

    /// Try to foreground the containing app, reporting real success/failure.
    ///
    /// UNSUPPORTED PATTERN — walk the responder chain up to the host process's
    /// UIApplication and call the non-deprecated
    /// `open(_:options:completionHandler:)` on it (the LocalSend approach).
    /// Apple has broken this family of workaround once already: iOS 18
    /// force-fails the deprecated `openURL:` selector, which is why this calls
    /// the modern three-argument method instead. Apple may break that one too;
    /// when it does, this reports false and the save-and-switch flow above is
    /// the designed degradation — the share itself never depends on this call.
    ///
    /// Why the IMP invocation instead of plain `application.open(...)`: UIKit
    /// marks `UIApplication` and this method extension-unavailable, a hard
    /// compile error under "Require Only App-Extension-Safe API" = YES — and
    /// that setting cannot be turned off for this target. The linker enforces
    /// it across the extension and everything it links ("Application
    /// extensions and any libraries they link to must be built with the
    /// APPLICATION_EXTENSION_API_ONLY build setting set to YES"), so flipping
    /// it here just moves the failure from compile to link. LocalSend writes
    /// the direct call only because their code lives in a pod built as a
    /// separate unit with the flag off; reproducing that would mean
    /// restructuring into a separate library. So: same call, same real result,
    /// invoked through its IMP under its ObjC selector
    /// `openURL:options:completionHandler:` (the non-deprecated three-argument
    /// method — NOT the iOS 18-kill-switched `openURL:`). Only UIApplication
    /// in the chain responds to that selector.
    ///
    /// The completion always fires exactly once, on the main queue.
    private func launchHostApp(completion: @escaping (Bool) -> Void) {
        guard let url = URL(string: Self.hostAppURL) else {
            completion(false)
            return
        }

        var finished = false
        let finish: (Bool) -> Void = { ok in
            DispatchQueue.main.async {
                guard !finished else { return }
                finished = true
                completion(ok)
            }
        }

        let sel = NSSelectorFromString("openURL:options:completionHandler:")

        // Diagnostic: the whole chain, so Console shows exactly what this
        // process's responder hierarchy looks like and which link we invoke.
        var chain: [String] = []
        var probe: UIResponder? = self
        while let p = probe {
            chain.append(String(describing: type(of: p)))
            probe = p.next
        }
        Self.log.notice("launch: responder chain: \(chain.joined(separator: " -> "), privacy: .public)")

        var responder: UIResponder? = self
        while let r = responder {
            if r.responds(to: sel) {
                // Diagnostics: the three lines below distinguish the failure
                // modes. "completed with success=false" = a real UIApplication
                // was reached and iOS refused the launch. "never called back"
                // = the call was swallowed without ever invoking the
                // completion. "never reached" (after the loop) = the chain
                // holds no object with this selector at all.
                Self.log.notice("launch: invoking open() on \(String(describing: type(of: r)), privacy: .public)")
                // If iOS no-ops the call without ever invoking the completion
                // block, fail over instead of hanging the sheet.
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) {
                    if !finished {
                        Self.log.notice("launch: open() never called back within 1s")
                    }
                    finish(false)
                }
                typealias OpenURLFn = @convention(c) (
                    NSObject, Selector, NSURL, NSDictionary,
                    (@convention(block) (Bool) -> Void)?
                ) -> Void
                let open = unsafeBitCast(r.method(for: sel), to: OpenURLFn.self)
                open(r, sel, url as NSURL, NSDictionary(), { ok in
                    Self.log.notice("launch: open() completed with success=\(ok ? "true" : "false", privacy: .public)")
                    finish(ok)
                })
                return
            }
            responder = r.next
        }

        // No UIApplication in the chain — the workaround's other failure mode.
        Self.log.notice("launch: UIApplication never reached — no responder answers openURL:options:completionHandler:")
        finish(false)
    }

    /// Fallback-only card, shown when the launch attempt failed: the hand-off
    /// already succeeded, the user just has to switch to Nubble themselves.
    /// Copy must not imply the app is opening (it isn't, in this path) —
    /// "Saved — open Nubble to import" states what happened and what's left.
    private func showConfirmation() {
        let card = UIVisualEffectView(effect: UIBlurEffect(style: .systemMaterial))
        card.layer.cornerRadius = 16
        card.clipsToBounds = true
        card.translatesAutoresizingMaskIntoConstraints = false

        let icon = UIImageView(image: UIImage(systemName: "checkmark.circle.fill"))
        icon.tintColor = .systemGreen
        icon.contentMode = .scaleAspectFit
        icon.translatesAutoresizingMaskIntoConstraints = false

        let label = UILabel()
        label.text = "Saved — open Nubble to import"
        label.font = .systemFont(ofSize: 15, weight: .semibold)
        label.textColor = .label
        label.numberOfLines = 1
        label.adjustsFontSizeToFitWidth = true
        label.minimumScaleFactor = 0.8
        label.translatesAutoresizingMaskIntoConstraints = false

        card.contentView.addSubview(icon)
        card.contentView.addSubview(label)
        view.addSubview(card)

        NSLayoutConstraint.activate([
            card.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            card.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            card.leadingAnchor.constraint(greaterThanOrEqualTo: view.leadingAnchor, constant: 24),
            card.trailingAnchor.constraint(lessThanOrEqualTo: view.trailingAnchor, constant: -24),

            icon.leadingAnchor.constraint(equalTo: card.contentView.leadingAnchor, constant: 16),
            icon.centerYAnchor.constraint(equalTo: card.contentView.centerYAnchor),
            icon.widthAnchor.constraint(equalToConstant: 24),
            icon.heightAnchor.constraint(equalToConstant: 24),

            label.leadingAnchor.constraint(equalTo: icon.trailingAnchor, constant: 10),
            label.trailingAnchor.constraint(equalTo: card.contentView.trailingAnchor, constant: -16),
            label.topAnchor.constraint(equalTo: card.contentView.topAnchor, constant: 14),
            label.bottomAnchor.constraint(equalTo: card.contentView.bottomAnchor, constant: -14),
        ])

        card.alpha = 0
        card.transform = CGAffineTransform(scaleX: 0.92, y: 0.92)
        UIView.animate(withDuration: 0.18) {
            card.alpha = 1
            card.transform = .identity
        }

        // The display clock starts now, when the card is actually on screen —
        // not when whichever code path decided to show it started running.
        cardShownAt = Date()
    }

    /// Completes the request exactly once, on the main thread. If the fallback
    /// card is on screen, completion is deferred until the card has been
    /// visible for its full confirmationSeconds — enforced HERE, at the single
    /// point of teardown, so no caller (the launch failover timer, a late
    /// open() callback, any future path) can cut the card short by completing
    /// early. Callers just call complete(); the card math is not their problem.
    private func complete() {
        if !Thread.isMainThread {
            DispatchQueue.main.async { self.complete() }
            return
        }
        guard !didComplete else { return }
        if let shownAt = cardShownAt {
            let remaining = Self.confirmationSeconds - Date().timeIntervalSince(shownAt)
            if remaining > 0.01 {
                Self.log.notice("complete() deferred \(Int(remaining * 1000), privacy: .public)ms for card display")
                DispatchQueue.main.asyncAfter(deadline: .now() + remaining) { self.complete() }
                return
            }
        }
        didComplete = true
        Self.log.notice("completing request")
        extensionContext?.completeRequest(returningItems: nil, completionHandler: nil)
    }
}
