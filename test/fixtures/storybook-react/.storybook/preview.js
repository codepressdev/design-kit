import "../src/theme.css";

// The app's theme switch: an attribute on <html>, not a class.
document.documentElement.setAttribute("data-theme", "light");

export default {
  parameters: { layout: "padded" },
};
