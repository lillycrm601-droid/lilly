import adapterNode from '@sveltejs/adapter-node';
import adapterVercel from '@sveltejs/adapter-vercel';

const isVercel = process.env.VERCEL || process.env.ADAPTER === 'vercel';

const config = {
  vitePlugin: {
    prebundleSvelteLibraries: false
  },
  kit: {
    adapter: isVercel ? adapterVercel() : adapterNode(),

    version: {
      pollInterval: 60000
    },

    experimental: {
      tracing: {
        server: true
      },

      instrumentation: {
        server: true
      }
    }
  }
};

export default config;