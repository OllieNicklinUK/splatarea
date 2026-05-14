/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        v-slate: {
          50: 'hsl(210, 40%, 98%)',
          900: 'hsl(222, 47%, 11%)',
        },
        v-accent: 'hsl(252, 62%, 55%)',
        v-danger: 'hsl(0, 72%, 51%)',
        v-success: 'hsl(142, 70%, 45%)',
      },
      backdropBlur: {
        'v-glass': '12px',
      }
    },
  },
  plugins: [],
}
