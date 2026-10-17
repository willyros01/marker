# Adds the privacy manifest to the freshly generated Xcode project as a resource.
require "xcodeproj"
project = Xcodeproj::Project.open("ios/App/App.xcodeproj")
target = project.targets.find { |t| t.name == "App" } or abort("No App target")
group = project.main_group.find_subpath("App", false) or abort("No App group")
manifest = group.files.find { |f| f.path == "PrivacyInfo.xcprivacy" } || group.new_reference("PrivacyInfo.xcprivacy")
target.resources_build_phase.add_file_reference(manifest, true)
project.save
puts "Xcode project: privacy manifest added as a resource."
