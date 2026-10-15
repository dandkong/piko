const { withAndroidManifest } = require("@expo/config-plugins");

module.exports = function withAndroidAdjustNothing(config) {
  return withAndroidManifest(config, config => {
    const activities = config.modResults.manifest.application?.[0]?.activity ?? [];
    const mainActivity = activities.find(({ $ }) => $?.["android:name"]?.endsWith(".MainActivity"));
    if (!mainActivity) throw new Error("Could not find Android MainActivity to configure keyboard overlay behavior.");
    mainActivity.$["android:windowSoftInputMode"] = "adjustNothing";
    return config;
  });
};
