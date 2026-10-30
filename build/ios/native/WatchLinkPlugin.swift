/* WatchLinkPlugin.swift — "Send to my watch" (Willy, 30 Oct 2026).
 *
 * Hands the followed card's code to The Marker on the paired Apple Watch
 * (WatchConnectivity application context: it arrives even when the watch app
 * is closed). Only the follow code, the course name, the worker's address and
 * the public Firebase web key are sent; the watch signs in on its own. */
import Foundation
import Capacitor
import WatchConnectivity

@objc(WatchLinkPlugin)
public class WatchLinkPlugin: CAPPlugin, CAPBridgedPlugin, WCSessionDelegate {
  public let identifier = "WatchLinkPlugin"
  public let jsName = "WatchLink"
  public let pluginMethods: [CAPPluginMethod] = [
    CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "send", returnType: CAPPluginReturnPromise),
  ]

  override public func load() {
    guard WCSession.isSupported() else { return }
    WCSession.default.delegate = self
    WCSession.default.activate()
  }

  @objc func status(_ call: CAPPluginCall) {
    guard WCSession.isSupported() else {
      call.resolve(["supported": false, "ready": false, "paired": false, "installed": false])
      return
    }
    let s = WCSession.default
    call.resolve(["supported": true, "ready": s.activationState == .activated, "paired": s.isPaired, "installed": s.isWatchAppInstalled])
  }

  @objc func send(_ call: CAPPluginCall) {
    guard WCSession.isSupported() else { call.reject("NOT_SUPPORTED"); return }
    let s = WCSession.default
    guard s.activationState == .activated else { s.activate(); call.reject("NOT_READY"); return }
    guard s.isPaired else { call.reject("NOT_PAIRED"); return }
    guard s.isWatchAppInstalled else { call.reject("NOT_INSTALLED"); return }
    var ctx: [String: Any] = ["sentAt": Date().timeIntervalSince1970]
    for k in ["code", "course", "workerUrl", "apiKey"] { ctx[k] = call.getString(k) ?? "" }
    do {
      try s.updateApplicationContext(ctx)
    } catch {
      call.reject("SEND_FAILED")
      return
    }
    if s.isReachable { s.sendMessage(ctx, replyHandler: nil, errorHandler: nil) }
    call.resolve(["sent": true])
  }

  public func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {}
  public func sessionDidBecomeInactive(_ session: WCSession) {}
  public func sessionDidDeactivate(_ session: WCSession) { WCSession.default.activate() }
}
