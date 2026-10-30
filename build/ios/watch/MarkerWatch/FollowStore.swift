/* FollowStore.swift — what the watch is following (Willy, 30 Oct 2026).
 *
 * The iPhone sends { code, course, workerUrl, apiKey, sentAt } with "Send to
 * my watch" (WatchConnectivity application context, which arrives even when
 * the watch app is closed). The watch then reads the card itself from the
 * worker's /follow/view, with its own anonymous sign-in, every 20 seconds
 * while it is on screen, signal permitting. It can never change anything. */
import Foundation
import SwiftUI
import WatchConnectivity

enum Route: Hashable {
  case player(Int, Int)   // golfer, hole (index in playing order)
  case summary(Int)       // golfer
}

struct FollowLink: Codable, Equatable {
  var code: String
  var course: String
  var workerUrl: String
  var apiKey: String
}

struct Refused: Error { let reason: String }

final class FollowStore: NSObject, ObservableObject, WCSessionDelegate {
  @Published var link: FollowLink?
  @Published var card: FollowCard?
  @Published var message: String?
  @Published var stale = false
  @Published var path: [Route] = []

  private var timer: Timer?
  private var loading = false
  private var idToken: String?
  private var idExpires = Date.distantPast
  private let defaults = UserDefaults.standard
  let demo = ProcessInfo.processInfo.arguments.contains("-markerDemo")

  override init() {
    super.init()
    if demo { loadDemo(); return }
    if let d = defaults.data(forKey: "link"), let l = try? JSONDecoder().decode(FollowLink.self, from: d) { link = l }
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
    let sent = (ctx["sentAt"] as? NSNumber)?.doubleValue ?? 0
    if sent <= defaults.double(forKey: "takenAt") { return }
    defaults.set(sent, forKey: "takenAt")
    guard let code = ctx["code"] as? String, !code.isEmpty,
          let worker = ctx["workerUrl"] as? String, worker.hasPrefix("https://"),
          let key = ctx["apiKey"] as? String, !key.isEmpty else { return }
    let l = FollowLink(code: code, course: ctx["course"] as? String ?? "", workerUrl: worker, apiKey: key)
    if l != link { card = nil; path = [] }
    message = nil
    link = l
    if let d = try? JSONEncoder().encode(l) { defaults.set(d, forKey: "link") }
    refresh()
  }

  func stop() {
    link = nil; card = nil; message = nil; stale = false; path = []
    defaults.removeObject(forKey: "link")
  }

  /* ---------- reading the card ---------- */

  func setActive(_ on: Bool) {
    timer?.invalidate(); timer = nil
    guard on, !demo else { return }
    refresh()
    timer = Timer.scheduledTimer(withTimeInterval: 20, repeats: true) { [weak self] _ in self?.refresh() }
  }

  func refresh() {
    guard !demo, let l = link, !loading else { return }
    if let c = card, c.finished { return }
    loading = true
    Task { @MainActor in
      defer { self.loading = false }
      do {
        let obj = try await self.view(l)
        guard self.link == l else { return }
        if let c = FollowCard.parse(obj) { self.card = c; self.stale = false; self.message = nil }
        else { self.message = "This card could not be read." }
      } catch let r as Refused {
        guard self.link == l else { return }
        self.message = r.reason
        if self.card != nil { self.stale = true }
      } catch {
        self.stale = true
      }
    }
  }

  private func view(_ l: FollowLink) async throws -> [String: Any] {
    let base = l.workerUrl.hasSuffix("/") ? String(l.workerUrl.dropLast()) : l.workerUrl
    guard let url = URL(string: base + "/follow/view") else { throw Refused(reason: "The card's address is not right. Send it again from the iPhone.") }
    for attempt in 0..<2 {
      let t = try await token(l.apiKey, fresh: attempt == 1)
      var req = URLRequest(url: url, timeoutInterval: 20)
      req.httpMethod = "POST"
      req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
      req.setValue("application/json", forHTTPHeaderField: "Content-Type")
      req.httpBody = try JSONSerialization.data(withJSONObject: ["code": l.code])
      let (data, resp) = try await URLSession.shared.data(for: req)
      let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
      if status == 401 || status == 403 {
        idToken = nil
        if attempt == 0 { continue }
        throw Refused(reason: "The watch could not sign in. Send the card again from the iPhone.")
      }
      guard (200..<300).contains(status) else { throw URLError(.badServerResponse) }
      let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
      if let e = obj["error"] as? String {
        throw Refused(reason: e == "REFUSED" ? (obj["reason"] as? String ?? "The card could not be opened.") : e)
      }
      return obj
    }
    throw URLError(.userAuthenticationRequired)
  }

  /* An anonymous sign-in of the watch's own, kept between starts (Firebase
     Auth over plain HTTPS: no Firebase library on the watch). */
  private func token(_ key: String, fresh: Bool) async throws -> String {
    if !fresh, let t = idToken, idExpires > Date().addingTimeInterval(120) { return t }
    if let r = defaults.string(forKey: "refreshToken"), let k = key.addingPercentEncoding(withAllowedCharacters: .alphanumerics),
       let url = URL(string: "https://securetoken.googleapis.com/v1/token?key=\(k)") {
      var req = URLRequest(url: url, timeoutInterval: 20)
      req.httpMethod = "POST"
      req.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
      req.setValue("https://willyros01.github.io/", forHTTPHeaderField: "Referer")
      let enc = r.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? r
      req.httpBody = "grant_type=refresh_token&refresh_token=\(enc)".data(using: .utf8)
      if let j = try? await json(req), let t = j["id_token"] as? String {
        keep(t, refresh: j["refresh_token"] as? String, expires: j["expires_in"])
        return t
      }
    }
    guard let k = key.addingPercentEncoding(withAllowedCharacters: .alphanumerics),
          let url = URL(string: "https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=\(k)") else {
      throw Refused(reason: "The watch could not sign in. Send the card again from the iPhone.")
    }
    var req = URLRequest(url: url, timeoutInterval: 20)
    req.httpMethod = "POST"
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.setValue("https://willyros01.github.io/", forHTTPHeaderField: "Referer")
    req.httpBody = try JSONSerialization.data(withJSONObject: ["returnSecureToken": true])
    let j = try await json(req)
    guard let t = j["idToken"] as? String else { throw URLError(.userAuthenticationRequired) }
    keep(t, refresh: j["refreshToken"] as? String, expires: j["expiresIn"])
    return t
  }

  private func keep(_ t: String, refresh: String?, expires: Any?) {
    idToken = t
    let secs = Double((expires as? String) ?? "") ?? (expires as? NSNumber)?.doubleValue ?? 3600
    idExpires = Date().addingTimeInterval(secs)
    if let r = refresh { defaults.set(r, forKey: "refreshToken") }
  }

  private func json(_ req: URLRequest) async throws -> [String: Any] {
    let (data, resp) = try await URLSession.shared.data(for: req)
    guard let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) else { throw URLError(.badServerResponse) }
    return (try JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
  }

  /* ---------- the build check: made-up scores, no network ---------- */

  private func loadDemo() {
    let pars = [4, 4, 3, 4, 5, 4, 5, 4, 3, 3, 4, 4, 4, 4, 4, 5, 3, 4]
    let yards = [338, 384, 124, 350, 547, 433, 460, 315, 199, 134, 371, 294, 387, 334, 302, 467, 91, 360]
    let si = [13, 9, 17, 7, 3, 1, 5, 15, 11, 16, 6, 10, 2, 12, 14, 8, 18, 4]
    let holes: [[String: Any]] = (0..<18).map { ["par": pars[$0], "yards": yards[$0], "si": si[$0]] }
    let obj: [String: Any] = [
      "setup": [
        "course": ["name": "Lakeview Golf Course"],
        "tee": ["name": "White", "par": 71, "holes": holes],
        "holes": "18", "start": 1, "order": Array(1...18),
        "players": [["name": "Raul", "ch": 14], ["name": "Willy", "ch": 18], ["name": "Raul", "ch": 20], ["name": "Golfer 4", "ch": 10]],
      ],
      "scores": [
        "0": ["1": 5, "2": 4, "3": 4, "4": 5, "5": 5, "6": 4, "7": 6],
        "1": ["1": 5, "2": 5, "3": 4, "4": 5, "5": 6, "6": 4, "7": 6],
        "2": ["1": 6, "2": 5, "3": 4, "4": 5, "5": 7, "6": 5, "7": 5],
        "3": ["1": 4, "2": 4, "3": 3, "4": 4, "5": 5, "6": 4, "7": 5],
      ],
      "lastAt": Date().timeIntervalSince1970 * 1000, "status": "live", "byCaddie": false,
    ]
    link = FollowLink(code: "DEMO00", course: "Lakeview Golf Course", workerUrl: "https://example.invalid", apiKey: "demo")
    card = FollowCard.parse(obj)
    let args = ProcessInfo.processInfo.arguments
    if let i = args.firstIndex(of: "-markerShow"), i + 1 < args.count {
      switch args[i + 1] {
      case "player": path = [.player(1, 6)]
      case "summary": path = [.player(1, 6), .summary(1)]
      case "waiting": link = nil; card = nil
      default: break
      }
    }
  }
}
