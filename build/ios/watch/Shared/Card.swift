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
  var posted: Bool
  var byCaddie: Bool
  var expiresAt: Date?

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
    var expiresAt: Date? = nil
    if let ms = obj["expiresAt"] as? NSNumber { expiresAt = Date(timeIntervalSince1970: ms.doubleValue / 1000) }
    return FollowCard(course: course, tee: teeObj["name"] as? String ?? "", order: order, holes: holes,
                      players: players, lastAt: lastAt, finished: (obj["status"] as? String) == "finished",
                      posted: (obj["posted"] as? Bool) ?? false,
                      byCaddie: (obj["byCaddie"] as? Bool) ?? false, expiresAt: expiresAt)
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

  /* A golfer's latest scored hole (index in playing order); the card's current hole when none. */
  func lastIndex(_ p: Int) -> Int {
    guard p >= 0 && p < players.count else { return currentIndex }
    var last: Int? = nil
    for (k, n) in order.enumerated() where players[p].scores[n] != nil { last = k }
    return last ?? currentIndex
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

/* ---------------- following a whole game (1.1.0, Willy 31 Oct 2026) ---------------- */

/* One golfer on the game's leaderboard; `card` and `player` say where. */
struct GameRow: Identifiable {
  let id: String
  let name: String
  let card: Int
  let player: Int
  let thru: Int
  let gross: Int
  let toPar: Int
  let complete: Bool
  let net: Int?
  var place: String = ""
}

/* The worker's answer for a game code: { kind: "game", game, date, cards, lastAt, finished }.
   The same leaderboard as the iPhone (card.js gameBoard): live in gross,
   best to par first; final in gross and net. */
struct GameBoard {
  var name: String
  var date: String
  var cards: [FollowCard]
  var lastAt: Date?
  var finished: Bool
  var expiresAt: Date?

  static func parse(_ obj: [String: Any]) -> GameBoard? {
    guard (obj["kind"] as? String) == "game" else { return nil }
    let cards = (obj["cards"] as? [[String: Any]] ?? []).compactMap { FollowCard.parse($0) }
    let name = (obj["game"] as? [String: Any])?["name"] as? String ?? ""
    var lastAt: Date? = nil
    if let ms = obj["lastAt"] as? NSNumber { lastAt = Date(timeIntervalSince1970: ms.doubleValue / 1000) }
    var expiresAt: Date? = nil
    if let ms = obj["expiresAt"] as? NSNumber { expiresAt = Date(timeIntervalSince1970: ms.doubleValue / 1000) }
    return GameBoard(name: name, date: obj["date"] as? String ?? "", cards: cards, lastAt: lastAt,
                     finished: (obj["finished"] as? Bool) ?? false, expiresAt: expiresAt)
  }

  var rows: [GameRow] {
    var out: [GameRow] = []
    for (ci, c) in cards.enumerated() {
      for pi in c.players.indices {
        let t = c.totals(pi)
        let complete = t.done == c.order.count
        let ch = c.players[pi].ch
        let net: Int? = (complete && ch != nil) ? t.gross - (ch ?? 0) : nil
        out.append(GameRow(id: "\(ci)-\(pi)", name: c.players[pi].name, card: ci, player: pi, thru: t.done,
                           gross: t.gross, toPar: t.toPar, complete: complete, net: net))
      }
    }
    return out
  }

  /* Places with ties ("T2") for a list already in order. */
  static func placed(_ list: [GameRow], _ key: (GameRow) -> Int) -> [GameRow] {
    var out = list
    var at = 0
    for i in out.indices {
      if i == 0 || key(out[i]) != key(out[i - 1]) { at = i + 1 }
      let v = key(out[i])
      let tied = list.filter { key($0) == v }.count > 1
      out[i].place = (tied ? "T" : "") + "\(at)"
    }
    return out
  }

  var live: [GameRow] {
    let started = rows.filter { $0.thru > 0 }.sorted { ($0.toPar, -$0.thru, $0.name) < ($1.toPar, -$1.thru, $1.name) }
    let waiting = rows.filter { $0.thru == 0 }.sorted { $0.name < $1.name }
    return GameBoard.placed(started) { $0.toPar } + waiting
  }
  var gross: [GameRow] {
    GameBoard.placed(rows.filter { $0.complete }.sorted { ($0.gross, $0.name) < ($1.gross, $1.name) }) { $0.gross }
  }
  var net: [GameRow] {
    GameBoard.placed(rows.filter { $0.net != nil }.sorted { ($0.net ?? 0, $0.name) < ($1.net ?? 0, $1.name) }) { $0.net ?? 0 }
  }
  var isFinal: Bool { finished && !cards.isEmpty }
}
