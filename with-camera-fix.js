const { withProjectBuildGradle } = require('@expo/config-plugins');

module.exports = (config) => {
  return withProjectBuildGradle(config, (config) => {
    if (config.modResults.language === 'groovy') {
      // Force androidx.camera versions to avoid AGP 8.6.0 requirement
      const fix = `
    configurations.all {
        resolutionStrategy {
            force 'androidx.camera:camera-camera2:1.4.0'
            force 'androidx.camera:camera-core:1.4.0'
            force 'androidx.camera:camera-view:1.4.0'
            force 'androidx.camera:camera-lifecycle:1.4.0'
            force 'androidx.camera:camera-extensions:1.4.0'
            force 'androidx.camera:camera-video:1.4.0'
        }
    }
`;
      if (!config.modResults.contents.includes('androidx.camera:camera-camera2:1.3.4')) {
        config.modResults.contents = config.modResults.contents.replace(
          /allprojects\s*\{/,
          `allprojects {${fix}`
        );
      }
    }
    return config;
  });
};
