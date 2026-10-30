/* FollowNet.swift — shared by the watch app and its watch-face widgets
 * (Willy, 30 Oct 2026). What is being followed, the last card read, and
 * reading it from the worker's /follow/view with the watch's own anonymous
 * sign-in (Firebase Auth over plain HTTPS). Kept in the app group, so the
 * widgets on the watch face and in the Smart Stack see what the app sees. */
import Foundation

let markerAppGroup = "group.io.github.willyros01.marker"

struct FollowLink: Codable, Equatable {
  var code: String
  var course: String
  var workerUrl: String
  var apiKey: String
}

struct Refused: Error { let reason: String }

enum Shared {
  static var defaults: UserDefaults { UserDefaults(suiteName: markerAppGroup) ?? .standard }

  /* Moves what an earlier version kept outside the app group (0.9.0 to 0.9.6). */
  static func migrate() {
    let old = UserDefaults.standard, d = defaults
    for k in ["link", "refreshToken", "takenAt"] where d.object(forKey: k) == nil {
      if let v = old.object(forKey: k) { d.set(v, forKey: k) }
    }
  }

  static func loadLink() -> FollowLink? {
    guard let data = defaults.data(forKey: "link") else { return nil }
    return try? JSONDecoder().decode(FollowLink.self, from: data)
  }
  static func saveLink(_ l: FollowLink?) {
    if let l = l, let data = try? JSONEncoder().encode(l) { defaults.set(data, forKey: "link") }
    else { defaults.removeObject(forKey: "link"); defaults.removeObject(forKey: "card") }
  }

  /* The worker's answer as it came, so both sides read it the same way. */
  static func saveCardData(_ data: Data?) {
    if let data = data { defaults.set(data, forKey: "card"); defaults.set(Date().timeIntervalSince1970, forKey: "cardAt") }
    else { defaults.removeObject(forKey: "card") }
  }
  static func loadCard() -> FollowCard? {
    guard let data = defaults.data(forKey: "card"),
          let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return nil }
    return FollowCard.parse(obj)
  }

  /* The golfer last opened on the watch: the one the "my score" widget shows. */
  static var me: Int {
    get { defaults.integer(forKey: "me") }
    set { defaults.set(newValue, forKey: "me") }
  }
}

enum FollowNet {
  private static var idToken: String?
  private static var idExpires = Date.distantPast

  /* The card as it stands: the parsed answer and its raw bytes. */
  static func view(_ l: FollowLink) async throws -> ([String: Any], Data) {
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
      return (obj, data)
    }
    throw URLError(.userAuthenticationRequired)
  }

  private static func token(_ key: String, fresh: Bool) async throws -> String {
    if !fresh, let t = idToken, idExpires > Date().addingTimeInterval(120) { return t }
    let d = Shared.defaults
    if let r = d.string(forKey: "refreshToken"), let k = key.addingPercentEncoding(withAllowedCharacters: .alphanumerics),
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

  private static func keep(_ t: String, refresh: String?, expires: Any?) {
    idToken = t
    let secs = Double((expires as? String) ?? "") ?? (expires as? NSNumber)?.doubleValue ?? 3600
    idExpires = Date().addingTimeInterval(secs)
    if let r = refresh { Shared.defaults.set(r, forKey: "refreshToken") }
  }

  private static func json(_ req: URLRequest) async throws -> [String: Any] {
    let (data, resp) = try await URLSession.shared.data(for: req)
    guard let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) else { throw URLError(.badServerResponse) }
    return (try JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
  }
}

/* Made-up scores for the build check and the widget gallery. */
extension FollowCard {
  static func sampleObject() -> [String: Any] {
    let pars = [4, 4, 3, 4, 5, 4, 5, 4, 3, 3, 4, 4, 4, 4, 4, 5, 3, 4]
    let yards = [338, 384, 124, 350, 547, 433, 460, 315, 199, 134, 371, 294, 387, 334, 302, 467, 91, 360]
    let si = [13, 9, 17, 7, 3, 1, 5, 15, 11, 16, 6, 10, 2, 12, 14, 8, 18, 4]
    let holes: [[String: Any]] = (0..<18).map { ["par": pars[$0], "yards": yards[$0], "si": si[$0]] }
    return [
      "setup": [
        "course": ["name": "Lakeview Golf Course"],
        "tee": ["name": "White", "par": 71, "holes": holes],
        "holes": "18", "start": 1, "order": Array(1...18),
        "players": [["name": "Raul Rosales", "ch": 14], ["name": "Willy Rosales", "ch": 18], ["name": "Raul", "ch": 20], ["name": "Golfer 4", "ch": 10]],
      ],
      "scores": [
        "0": ["1": 5, "2": 4, "3": 4, "4": 5, "5": 5, "6": 4, "7": 6],
        "1": ["1": 5, "2": 5, "3": 4, "4": 5, "5": 6, "6": 4, "7": 6],
        "2": ["1": 6, "2": 5, "3": 4, "4": 5, "5": 7, "6": 5, "7": 5],
        "3": ["1": 4, "2": 4, "3": 3, "4": 4, "5": 5, "6": 4, "7": 5],
      ],
      "lastAt": Date().timeIntervalSince1970 * 1000, "status": "live", "byCaddie": false,
    ]
  }
  static var sample: FollowCard? { parse(sampleObject()) }
}

func firstName(_ s: String) -> String {
  let parts = s.split(separator: " ")
  return parts.first.map(String.init) ?? s
}
