/* FollowStore.swift — what the watch is following (Willy, 30 Oct 2026).
 *
 * The iPhone sends { code, course, workerUrl, apiKey, sentAt } with "Send to
 * my watch" (WatchConnectivity application context, which arrives even when
 * the watch app is closed). The watch then reads the card itself from the
 * worker's /follow/view (FollowNet), with its own anonymous sign-in, every 20
 * seconds while it is on screen, signal permitting. It can never change
 * anything. What it follows and the last card read are kept in the app group
 * (Shared), for the watch-face widgets. */
import Foundation
import SwiftUI
import WatchConnectivity
import WidgetKit

enum Route: Hashable {
  case player(Int, Int)   // golfer, hole (index in playing order)
  case summary(Int)       // golfer
}

final class FollowStore: NSObject, ObservableObject, WCSessionDelegate {
  @Published var link: FollowLink?
  @Published var card: FollowCard?
  @Published var message: String?
  @Published var stale = false
  @Published var path: [Route] = []
  @Published var showWidgets = false

  private var timer: Timer?
  private var loading = false
  private var endedSeen: Date?   /* when the watch first saw the round posted */
  let demo = ProcessInfo.processInfo.arguments.contains("-markerDemo")

  override init() {
    super.init()
    if demo { loadDemo(); return }
    Shared.migrate()
    link = Shared.loadLink()
    if link != nil { card = Shared.loadCard() }
    if WCSession.isSupported() {
      WCSession.default.delegate = self
      WCSession.default.activate()
    }
  }

  /* ---------- from the iPhone ---------- */

  func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
    let ctx = session.receivedApplicationContext
    if !ctx.isEmpty { DispatchQueue.main.async { self.take(ctx) } }
  }
  func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
    DispatchQueue.main.async { self.take(applicationContext) }
  }
  func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
    DispatchQueue.main.async { self.take(message) }
  }

  /* Each send is taken once (the same context comes back at every start). */
  private func take(_ ctx: [String: Any]) {
    let d = Shared.defaults
    let sent = (ctx["sentAt"] as? NSNumber)?.doubleValue ?? 0
    if sent <= d.double(forKey: "takenAt") { return }
    d.set(sent, forKey: "takenAt")
    guard let code = ctx["code"] as? String, !code.isEmpty,
          let worker = ctx["workerUrl"] as? String, worker.hasPrefix("https://"),
          let key = ctx["apiKey"] as? String, !key.isEmpty else { return }
    let l = FollowLink(code: code, course: ctx["course"] as? String ?? "", workerUrl: worker, apiKey: key)
    if l != link { card = nil; path = []; endedSeen = nil; Shared.saveCardData(nil) }
    message = nil
    link = l
    Shared.saveLink(l)
    reloadWidgets()
    refresh()
  }

  func stop(_ why: String? = nil) {
    link = nil; card = nil; stale = false; path = []; endedSeen = nil
    message = why
    Shared.saveLink(nil)
    reloadWidgets()
  }

  /* The golfer last opened: the "my score" box on the watch face shows them. */
  func setMe(_ p: Int) {
    guard !demo, Shared.me != p else { return }
    Shared.me = p
    reloadWidgets()
  }

  private func reloadWidgets() {
    guard !demo else { return }
    WidgetCenter.shared.reloadAllTimelines()
  }

  /* ---------- reading the card ---------- */

  func setActive(_ on: Bool) {
    timer?.invalidate(); timer = nil
    guard on, !demo else { return }
    /* Following ends when the round is posted (shown until the watch is next
       opened, at least 10 minutes later) and after its 12 hours (Willy, 30 Oct 2026). */
    if let seen = endedSeen, Date().timeIntervalSince(seen) > 600 { stop(); return }
    if let c = card, let until = c.expiresAt, Date() >= until { stop("The 12 hours are over. Send a card again from the iPhone."); return }
    refresh()
    timer = Timer.scheduledTimer(withTimeInterval: 20, repeats: true) { [weak self] _ in self?.refresh() }
  }

  func refresh() {
    guard !demo, let l = link, !loading else { return }
    if let c = card, c.posted { return }
    loading = true
    Task { @MainActor in
      defer { self.loading = false }
      do {
        let (obj, data) = try await FollowNet.view(l)
        guard self.link == l else { return }
        if let c = FollowCard.parse(obj) {
          let changed = Shared.defaults.data(forKey: "card") != data
          self.card = c; self.stale = false; self.message = nil
          Shared.saveCardData(data)
          if changed { self.reloadWidgets() }
          if c.posted && self.endedSeen == nil { self.endedSeen = Date() }
        } else { self.message = "This card could not be read." }
      } catch let r as Refused {
        guard self.link == l else { return }
        if r.reason.contains("stopped working") || r.reason.contains("doesn't work") { self.stop(r.reason); return }
        self.message = r.reason
        if self.card != nil { self.stale = true }
      } catch {
        self.stale = true
      }
    }
  }

  /* ---------- the build check: made-up scores, no network ---------- */

  private func loadDemo() {
    link = FollowLink(code: "DEMO00", course: "Lakeview Golf Course", workerUrl: "https://example.invalid", apiKey: "demo")
    card = FollowCard.sample
    let args = ProcessInfo.processInfo.arguments
    if let i = args.firstIndex(of: "-markerShow"), i + 1 < args.count {
      switch args[i + 1] {
      case "player": path = [.player(1, 6)]
      case "summary": path = [.player(1, 6), .summary(1)]
      case "waiting": link = nil; card = nil
      case "widgets": showWidgets = true
      default: break
      }
    }
  }
}
