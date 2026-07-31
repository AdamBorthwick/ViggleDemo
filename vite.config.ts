import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  // Relative base so the build works at any GitHub Pages path
  // (user.github.io/repo-name) without hardcoding the repo name.
  base: './',
  plugins: [react(), tailwindcss()],
})
