// existing code...

module.exports = {
  // existing config...
  async rewrites() {
    return [
      // existing rewrites...
      {
        source: '/api/:path*',
        destination: 'http://localhost:3000/api/:path*',
      },
    ];
  },
};

// existing code...