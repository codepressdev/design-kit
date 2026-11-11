export default {
  stories: ["../src/**/*.stories.jsx"],
  framework: { name: "@storybook/react-vite", options: {} },
  staticDirs: ["../public"],
  core: { disableTelemetry: true },
};
