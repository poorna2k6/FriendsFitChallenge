module.exports = {
  darkMode: 'class',
  content: ['./public/index.html', './public/*.js'],
  theme: {
    extend: {
      fontFamily: { sans: ['Inter', 'system-ui', 'sans-serif'] },
      colors: {
        brand: { 50: '#ecfdf5', 100: '#d1fae5', 400: '#34d399', 500: '#10b981', 600: '#059669', 900: '#064e3b' }
      }
    }
  }
};
