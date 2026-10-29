# Adds the privacy manifest to the freshly generated Xcode project as a resource.
require "xcodeproj"
project = Xcodeproj::Project.open("ios/App/App.xcodeproj")
target = project.targets.find { |t| t.name == "App" } or abort("No App target")
group = project.main_group.find_subpath("App", false) or abort("No App group")
manifest = group.files.find { |f| f.path == "PrivacyInfo.xcprivacy" } || group.new_reference("PrivacyInfo.xcprivacy")
target.resources_build_phase.add_file_reference(manifest, true)
# Caddie links (www.cuberoot-systems.com/marker/caddie/) open the app.
group.files.find { |f| f.path == "App.entitlements" } || group.new_reference("App.entitlements")
target.build_configurations.each { |config| config.build_settings["CODE_SIGN_ENTITLEMENTS"] = "App/App.entitlements" }
project.save
puts "Xcode project: privacy manifest added as a resource; entitlements (caddie links) set."
