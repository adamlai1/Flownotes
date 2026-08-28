import UIKit
import UniformTypeIdentifiers
import os.log

/// Nubble's share sheet entry. Deliberately minimal: extensions run under
/// tight memory limits, so this does nothing with the text beyond handing it
/// off — write it to App Group UserDefaults, show a brief "saved" confirmation,
/// and complete the request. The user then foregrounds Nubble themselves and
/// the app collects the payload (src/lib/shareImport.js).
///
/// There is deliberately NO attempt to open the containing app from here.
/// Apple provides no supported way to do that from a share extension, and
/// since iOS 18 UIKit force-fails the old responder-chain openURL: hack
/// ("Force returning false (NO)"). Save-and-switch is the sanctioned flow.
///
/// Accepts plain text and URLs only — the activation rule in Info.plist keeps
/// Nubble out of the share sheet for anything else, so images and files are
/// declined by never matching rather than half-handled here.
class ShareViewController: UIViewController {

    // Must match SharedImportPlugin in App/App/SceneDelegate.swift.
    private static let appGroupId = "group.com.adamlai.flownotes"
    private static let textKey = "shareText"
    private static let tsKey = "shareTs"

    // Filter Console.app on this subsystem to watch the hand-off. Content is
    // never logged, only lengths.
    private static let log = Logger(subsystem: "com.adamlai.flownotes.ShareExtension", category: "share")

    // Long enough to read "Saved", short enough to not feel like a modal.
    private static let confirmationSeconds: TimeInterval = 1.5

    private var didHandle = false

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

            self.showConfirmation()
            DispatchQueue.main.asyncAfter(deadline: .now() + Self.confirmationSeconds) {
                self.complete()
            }
        }
    }

    /// Small centered card: the hand-off already succeeded, the user just has
    /// to switch to Nubble. Copy is deliberately "saved", not an instruction
    /// that could read as an error.
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
    }

    private func complete() {
        extensionContext?.completeRequest(returningItems: nil, completionHandler: nil)
    }
}
