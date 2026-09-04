import AppIntents
import Foundation
import os.log

// ── Bubble entity for "add a note to Ideas in Nubble" ───────────────────────
//
// Siri can only put an AppEntity (or AppEnum) inside a spoken phrase, so the
// bubble parameter is an entity backed by a MIRROR of the device's bubbles:
// the web layer pushes {id, name, path, project} records into the App Group
// (VoiceCapturePlugin.setBubbles → VoiceCaptureStore.writeBubbles) whenever
// the bubble set changes, and VoiceBubbleSync.refresh() tells Siri to
// re-read suggestedEntities() so a new bubble becomes sayable.
//
// Every lookup here is BEST-EFFORT and never blocks perform(): the capture
// must land whether or not filing can be worked out. A bubble that has gone
// missing, a mirror that can't be read, or a spoken name that matches
// nothing all resolve to *something*, and the web consumer makes the final
// filing decision (found → that bubble; not found → root, with a toast).
//
// This file is compiled into the App target alongside AddNoteIntent.swift
// (ios/VOICE_CAPTURE_SETUP.md, Part B) — never into SceneDelegate.swift's
// world, which must keep compiling before either file is added.

@available(iOS 16.0, *)
struct BubbleEntity: AppEntity {
    static var typeDisplayRepresentation: TypeDisplayRepresentation = "Bubble"
    static var defaultQuery = BubbleQuery()

    /// A real bubble id from the mirror, or `name:<spoken text>` for a name
    /// Siri handed us that the mirror doesn't know (see BubbleQuery).
    var id: String
    var name: String
    /// "Parent › Child · Project" — what Siri shows under duplicate names so
    /// the user can pick the right "Ideas".
    var subtitle: String?

    static let placeholderPrefix = "name:"
    var isPlaceholder: Bool { id.hasPrefix(Self.placeholderPrefix) }

    var displayRepresentation: DisplayRepresentation {
        if let subtitle = subtitle, !subtitle.isEmpty {
            return DisplayRepresentation(title: "\(name)", subtitle: "\(subtitle)")
        }
        return DisplayRepresentation(title: "\(name)")
    }

    /// From a mirror record written by the web layer. Records that lack an
    /// id or name are skipped rather than trusted.
    init?(record: [String: Any]) {
        guard let id = record["id"] as? String, !id.isEmpty,
              let name = record["name"] as? String, !name.isEmpty else { return nil }
        self.id = id
        self.name = name
        let path = (record["path"] as? String) ?? ""
        let project = (record["project"] as? String) ?? ""
        switch (path.isEmpty, project.isEmpty) {
        case (false, false): subtitle = "\(path) · \(project)"
        case (false, true):  subtitle = path
        case (true, false):  subtitle = project
        case (true, true):   subtitle = nil
        }
    }

    init(id: String, name: String, subtitle: String?) {
        self.id = id
        self.name = name
        self.subtitle = subtitle
    }

    static func placeholder(for spoken: String) -> BubbleEntity {
        BubbleEntity(id: placeholderPrefix + spoken, name: spoken, subtitle: nil)
    }

    static func mirror() -> [BubbleEntity] {
        VoiceCaptureStore.bubbleRecords().compactMap { BubbleEntity(record: $0) }
    }
}

@available(iOS 16.0, *)
struct BubbleQuery: EntityQuery, EntityStringQuery {
    private static let log = Logger(subsystem: "com.adamlai.flownotes.VoiceCapture", category: "bubbles")

    /// Siri resolving ids it cached from suggestedEntities(). An id the
    /// mirror no longer has (bubble deleted, or mirror unreadable) still
    /// comes back as an entity, so the intent runs and the capture is
    /// written with the id attached; the app sorts out filing.
    func entities(for identifiers: [String]) async throws -> [BubbleEntity] {
        let mirror = BubbleEntity.mirror()
        return identifiers.map { id in
            if let hit = mirror.first(where: { $0.id == id }) { return hit }
            if id.hasPrefix(BubbleEntity.placeholderPrefix) {
                return BubbleEntity.placeholder(for: String(id.dropFirst(BubbleEntity.placeholderPrefix.count)))
            }
            Self.log.notice("bubble id not in mirror — passing through for the app to resolve")
            return BubbleEntity(id: id, name: "a bubble", subtitle: nil)
        }
    }

    /// The values Siri precomputes phrases for. Filtering (unsayable names,
    /// the cap) already happened on the web side when the mirror was built.
    func suggestedEntities() async throws -> [BubbleEntity] {
        BubbleEntity.mirror()
    }

    /// A spoken or typed name that didn't come from the cached list — the
    /// Shortcuts editor's search box, and Siri on versions that resolve free
    /// text. Exact match wins, then substring; an unknown name returns a
    /// PLACEHOLDER rather than nothing, so the capture goes ahead and the
    /// app files it by name if the bubble exists by then, else at root.
    func entities(matching string: String) async throws -> [BubbleEntity] {
        let query = string.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return BubbleEntity.mirror() }
        let mirror = BubbleEntity.mirror()
        let needle = query.lowercased()
        let exact = mirror.filter { $0.name.lowercased() == needle }
        if !exact.isEmpty { return exact }
        let partial = mirror.filter { $0.name.lowercased().contains(needle) }
        if !partial.isEmpty { return partial }
        Self.log.notice("no bubble matches spoken name (\(query.count, privacy: .public) chars) — placeholder")
        return [BubbleEntity.placeholder(for: query)]
    }
}

/// Called by VoiceCapturePlugin (SceneDelegate.swift) after every mirror
/// write — by CLASS NAME at runtime, because that file must keep compiling
/// when this one isn't in the target yet. Tells Siri the entity set changed
/// so the new phrase variants exist. Without this a freshly created bubble
/// isn't sayable until the next reinstall.
@objc(VoiceBubbleSync)
final class VoiceBubbleSync: NSObject {
    @objc static func refresh() {
        if #available(iOS 16.0, *) {
            NubbleShortcuts.updateAppShortcutParameters()
        }
    }
}
