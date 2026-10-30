/* Card.swift — the followed card on the watch (Willy, 30 Oct 2026).
 *
 * The same answer the iPhone's Following screen gets from the worker
 * (/follow/view), read with the same scoring rules as card.js: a picked-up
 * hole counts as its cap (net double bogey; par + 5 without a handicap). */
import Foundation

enum Score: Equatable {
  case strokes(Int)
  case pickedUp
}

struct Hole {
  let n: Int
  let par: Int
  let yards: Int?
  let si: Int?
}

struct Player {
  let name: String
  let ch: Int?
  var scores: [Int: Score]
}

struct Totals {
  var gross = 0
  var toPar = 0
  var done = 0
}

struct FollowCard {
  var course: String
  var tee: String
  var order: [Int]
  var holes: [Hole]
  var players: [Player]
  var lastAt: Date?
  var finished: Bool
  var byCaddie: Bool

  static func num(_ v: Any?) -> Int? {
    if let n = v as? NSNumber { return Int(n.doubleValue.rounded()) }
    if let s = v as? String, let d = Double(s) { return Int(d.rounded()) }
    return nil
  }

  /* The worker's answer: { setup, scores, lastAt, status, byCaddie }. */
  static func parse(_ obj: [String: Any]) -> FollowCard? {
    guard let setup = obj["setup"] as? [String: Any] else { return nil }
    let course = (setup["course"] as? [String: Any])?["name"] as? String ?? ""
    let teeObj = setup["tee"] as? [String: Any] ?? [:]
    let rawHoles = teeObj["holes"] as? [[String: Any]] ?? []
    var holes: [Hole] = []
    for (i, h) in rawHoles.enumerated() {
      holes.append(Hole(n: i + 1, par: num(h["par"]) ?? 4, yards: num(h["yards"]), si: num(h["si"])))
    }
    let order = (setup["order"] as? [Any] ?? []).compactMap { num($0) }.filter { $0 >= 1 && $0 <= 18 }
    guard !order.isEmpty else { return nil }
    let rawPlayers = setup["players"] as? [[String: Any]] ?? []
    let scoresObj = obj["scores"] as? [String: Any] ?? [:]
    var players: [Player] = []
    for (i, p) in rawPlayers.enumerated() {
      var s: [Int: Score] = [:]
      if let mine = scoresObj[String(i)] as? [String: Any] {
        for (k, v) in mine {
          guard let n = Int(k) else { continue }
          if let text = v as? String, text == "X" { s[n] = .pickedUp }
          else if let x = num(v), x >= 1, x <= 20 { s[n] = .strokes(x) }
        }
      }
      players.append(Player(name: p["name"] as? String ?? "", ch: num(p["ch"]), scores: s))
    }
    guard !players.isEmpty else { return nil }
    var lastAt: Date? = nil
    if let ms = obj["lastAt"] as? NSNumber { lastAt = Date(timeIntervalSince1970: ms.doubleValue / 1000) }
    return FollowCard(course: course, tee: teeObj["name"] as? String ?? "", order: order, holes: holes,
                      players: players, lastAt: lastAt, finished: (obj["status"] as? String) == "finished",
                      byCaddie: (obj["byCaddie"] as? Bool) ?? false)
  }

  func hole(_ n: Int) -> Hole {
    let i = n - 1
    if i >= 0 && i < holes.count { return holes[i] }
    return Hole(n: n, par: 4, yards: nil, si: nil)
  }

  /* The hole being played: the furthest hole in playing order that anyone has a score on. */
  var currentIndex: Int {
    var last = 0
    for (k, n) in order.enumerated() where players.contains(where: { $0.scores[n] != nil }) { last = k }
    return last
  }

  /* Strokes received on a hole (World Handicap System allocation), as card.js strokesOn. */
  static func strokesOn(_ ch: Int?, _ si: Int?) -> Int {
    guard let ch = ch else { return 0 }
    guard let si = si, si > 0 else { return ch > 0 ? Int((Double(ch) / 18).rounded()) : 0 }
    if ch >= 0 { return ch / 18 + ((ch % 18) >= si ? 1 : 0) }
    let give = -ch
    return -(give / 18 + ((19 - si) <= (give % 18) ? 1 : 0))
  }

  static func holeCap(_ par: Int, _ ch: Int?, _ si: Int?) -> Int {
    guard ch != nil else { return par + 5 }
    return par + 2 + strokesOn(ch, si)
  }

  /* Totals for one player over some holes (all of them by default). */
  func totals(_ p: Int, _ only: [Int]? = nil) -> Totals {
    var t = Totals()
    guard p >= 0 && p < players.count else { return t }
    let pl = players[p]
    for n in only ?? order {
      guard let s = pl.scores[n] else { continue }
      let h = hole(n)
      let g: Int
      switch s {
      case .strokes(let x): g = x
      case .pickedUp: g = FollowCard.holeCap(h.par, pl.ch, h.si)
      }
      t.gross += g
      t.toPar += g - h.par
      t.done += 1
    }
    return t
  }

  var frontNine: [Int] { order.filter { $0 <= 9 } }
  var backNine: [Int] { order.filter { $0 >= 10 } }
}

func toParText(_ d: Int) -> String {
  if d == 0 { return "E" }
  return d > 0 ? "+\(d)" : "−\(-d)"
}

func scoreText(_ s: Score?) -> String {
  switch s {
  case .some(.strokes(let x)): return "\(x)"
  case .some(.pickedUp): return "X"
  case .none: return "·"
  }
}

func scoreName(_ s: Score?, par: Int) -> String {
  guard let s = s else { return "Not yet" }
  switch s {
  case .pickedUp: return "Picked up"
  case .strokes(let x):
    if x == 1 { return "Hole in one" }
    let d = x - par
    if d <= -3 { return "Albatross" }
    if d == -2 { return "Eagle" }
    if d == -1 { return "Birdie" }
    if d == 0 { return "Par" }
    if d == 1 { return "Bogey" }
    if d == 2 { return "Double" }
    return "+\(d)"
  }
}
