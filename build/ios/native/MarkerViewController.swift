/* MarkerViewController.swift — The Marker's own bridge, so the app's own
 * plugin (WatchLink, "Send to my watch") is part of it. Main.storyboard is
 * pointed at this class by build/ios-project.sh. */
import UIKit
import Capacitor

class MarkerViewController: CAPBridgeViewController {
  override open func capacitorDidLoad() {
    bridge?.registerPluginInstance(WatchLinkPlugin())
  }
}
