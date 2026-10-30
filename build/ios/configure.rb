# Finishes the freshly generated Xcode project: privacy manifest, entitlements
# (caddie and follow links), the app's own bridge (Send to my watch) and the
# Apple Watch app (0.9.0, Willy 30 Oct 2026), embedded in the iPhone app.
require "xcodeproj"
project = Xcodeproj::Project.open("ios/App/App.xcodeproj")
target = project.targets.find { |t| t.name == "App" } or abort("No App target")
group = project.main_group.find_subpath("App", false) or abort("No App group")

manifest = group.files.find { |f| f.path == "PrivacyInfo.xcprivacy" } || group.new_reference("PrivacyInfo.xcprivacy")
target.resources_build_phase.add_file_reference(manifest, true)

# Caddie and follow links (www.cuberoot-systems.com/marker/...) open the app.
group.files.find { |f| f.path == "App.entitlements" } || group.new_reference("App.entitlements")
target.build_configurations.each do |config|
  config.build_settings["CODE_SIGN_ENTITLEMENTS"] = "App/App.entitlements"
  config.build_settings["PRODUCT_BUNDLE_IDENTIFIER"] = "io.github.willyros01.marker"
end

# The app's own bridge, with the WatchLink plugin.
%w[MarkerViewController.swift WatchLinkPlugin.swift].each do |name|
  ref = group.files.find { |f| f.path == name } || group.new_reference(name)
  target.source_build_phase.add_file_reference(ref, true)
end

# The Apple Watch app.
wgroup = project.main_group.new_group("MarkerWatch", "MarkerWatch")
watch = project.new_target(:application, "MarkerWatch", :watchos, "10.0")
Dir.children("ios/App/MarkerWatch").sort.each do |name|
  next if name.start_with?(".")
  if name.end_with?(".swift")
    watch.source_build_phase.add_file_reference(wgroup.new_reference(name), true)
  elsif name == "Assets.xcassets"
    watch.resources_build_phase.add_file_reference(wgroup.new_reference(name), true)
  elsif name == "Info.plist"
    wgroup.new_reference(name)
  end
end
watch.build_configurations.each do |config|
  s = config.build_settings
  s["PRODUCT_BUNDLE_IDENTIFIER"] = "io.github.willyros01.marker.watchkitapp"
  s["PRODUCT_NAME"] = "MarkerWatch"
  s["INFOPLIST_FILE"] = "MarkerWatch/Info.plist"
  s["GENERATE_INFOPLIST_FILE"] = "NO"
  s["SDKROOT"] = "watchos"
  s["SUPPORTED_PLATFORMS"] = "watchos watchsimulator"
  s["TARGETED_DEVICE_FAMILY"] = "4"
  s["WATCHOS_DEPLOYMENT_TARGET"] = "10.0"
  s["SWIFT_VERSION"] = "5.0"
  s["ASSETCATALOG_COMPILER_APPICON_NAME"] = "AppIcon"
  s["CODE_SIGN_STYLE"] = "Automatic"
  s["SKIP_INSTALL"] = "YES"
  s["ENABLE_PREVIEWS"] = "NO"
  s["LD_RUNPATH_SEARCH_PATHS"] = ["$(inherited)", "@executable_path/Frameworks"]
end

# Embedded in the iPhone app, built with it.
embed = target.new_copy_files_build_phase("Embed Watch Content")
embed.dst_subfolder_spec = "16"
embed.dst_path = "$(CONTENTS_FOLDER_PATH)/Watch"
bf = embed.add_file_reference(watch.product_reference, true)
bf.settings = { "ATTRIBUTES" => ["RemoveHeadersOnCopy"] }
target.add_dependency(watch)

project.save
puts "Xcode project: privacy manifest, entitlements, WatchLink bridge, and the MarkerWatch app (embedded)."
