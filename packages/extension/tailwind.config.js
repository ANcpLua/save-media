/** @type {import('tailwindcss').Config} */
export default {
  content: ["./src/**/*.{ts,tsx,html}"],
  theme: {
    extend: {
      colors: {
        ink: "#0e1b26",
        surface: "#18242e",
        "surface-2": "#22323d",
        line: "#28343f",
        muted: "#9fb2be",
        accent: "#f5a623",
      },
    },
  },
  plugins: [],
};
