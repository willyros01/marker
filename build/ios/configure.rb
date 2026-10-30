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

# The Apple Watch app, and its watch-face widgets (both use Shared/).
def add_folder(project, folder, target)
  g = project.main_group.new_group(folder, folder)
  Dir.children("ios/App/#{folder}").sort.each do |name|
    next if name.start_with?(".")
    ref = g.new_reference(name)
    if name.end_with?(".swift")
      target.each { |t| t.source_build_phase.add_file_reference(ref, true) }
    elsif name == "Assets.xcassets"
      target.each { |t| t.resources_build_phase.add_file_reference(ref, true) }
    end
  end
end
watch = project.new_target(:application, "MarkerWatch", :watchos, "10.0")
widgets = project.new_target(:app_extension, "MarkerWidgets", :watchos, "10.0")
add_folder(project, "MarkerWatch", [watch])
add_folder(project, "MarkerWidgets", [widgets])
add_folder(project, "Shared", [watch, widgets])
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
  s["CODE_SIGN_ENTITLEMENTS"] = "MarkerWatch/MarkerWatch.entitlements"
end
widgets.build_configurations.each do |config|
  s = config.build_settings
  s["PRODUCT_BUNDLE_IDENTIFIER"] = "io.github.willyros01.marker.watchkitapp.widgets"
  s["PRODUCT_NAME"] = "MarkerWidgets"
  s["INFOPLIST_FILE"] = "MarkerWidgets/Info.plist"
  s["GENERATE_INFOPLIST_FILE"] = "NO"
  s["SDKROOT"] = "watchos"
  s["SUPPORTED_PLATFORMS"] = "watchos watchsimulator"
  s["TARGETED_DEVICE_FAMILY"] = "4"
  s["WATCHOS_DEPLOYMENT_TARGET"] = "10.0"
  s["SWIFT_VERSION"] = "5.0"
  s["CODE_SIGN_STYLE"] = "Automatic"
  s["CODE_SIGN_ENTITLEMENTS"] = "MarkerWidgets/MarkerWidgets.entitlements"
  s["SKIP_INSTALL"] = "YES"
  s["APPLICATION_EXTENSION_API_ONLY"] = "YES"
  s["ENABLE_PREVIEWS"] = "NO"
  s["LD_RUNPATH_SEARCH_PATHS"] = ["$(inherited)", "@executable_path/Frameworks", "@executable_path/../../Frameworks"]
end
wembed = watch.new_copy_files_build_phase("Embed Foundation Extensions")
wembed.dst_subfolder_spec = "13"
wembed.dst_path = ""
wbf = wembed.add_file_reference(widgets.product_reference, true)
wbf.settings = { "ATTRIBUTES" => ["RemoveHeadersOnCopy"] }
watch.add_dependency(widgets)

# Embedded in the iPhone app, built with it.
embed = target.new_copy_files_build_phase("Embed Watch Content")
embed.dst_subfolder_spec = "16"
embed.dst_path = "$(CONTENTS_FOLDER_PATH)/Watch"
bf = embed.add_file_reference(watch.product_reference, true)
bf.settings = { "ATTRIBUTES" => ["RemoveHeadersOnCopy"] }
target.add_dependency(watch)

project.save
puts "Xcode project: privacy manifest, entitlements, WatchLink bridge, the MarkerWatch app (embedded) and its MarkerWidgets."
