# Stremio Streaming Catalogs Addon — Multilingual Fork

![image](https://user-images.githubusercontent.com/6817390/216839228-f0d09dfd-e76b-4d23-bf4f-cab09febd1ef.png)

> **🌍 This is a multilingual fork** of
> **[rleroi/Stremio-Streaming-Catalogs-Addon](https://github.com/rleroi/Stremio-Streaming-Catalogs-Addon)**.
> It adds support for catalog metadata in 80+ languages via TMDB. See
> [`NOTICES.md`](NOTICES.md) for upstream attribution and license.
>
> All credit for the original addon goes to
> [@rleroi](https://github.com/rleroi) — please consider
> [supporting them on Ko-fi](https://ko-fi.com/rab1t).

A Stremio addon that provides streaming catalogs from various popular streaming services including Netflix, Disney+, HBO Max, Prime Video, Apple TV+, and many more. This addon allows users to browse and discover content from multiple streaming platforms directly within Stremio.

> **What's new in this fork:** All catalog titles, descriptions and posters are
> fetched from **TMDB in your language** (80+ supported) instead of being
> hardcoded English. The language is selected via the `CATALOG_LANGUAGE`
> environment variable (e.g. `de`, `fr`, `ja`, `es`, …). See
> [`docs/I18N.md`](docs/I18N.md) for the full list of supported languages and
> configuration options.

## Features

- **🌍 Multilingual metadata** — titles, descriptions, posters in 80+ languages via TMDB
- **🚀 Persistent TMDB cache** — repeated boots reuse the same IMDB→TMDB-ID mappings, no rate-limit churn
- **🛡️ Graceful fallback** — TMDB outages fall back to Cinemeta, never crashes the catalog

**Original features (inherited from upstream):**

- **Multiple Streaming Services**: Support for 20+ streaming platforms
- **Country-based Filtering**: Filter providers by country/region
- **Web Interface**: Modern Vue.js web interface for configuration
- **Real-time Catalogs**: Live streaming catalogs from various services
- **Easy Installation**: Simple addon installation process

## Quick Start — Homelab (Stremio Addon)

Want to run this as a Stremio addon on your home network? Three commands:

```bash
git clone https://github.com/mkslzk/stremio-streaming-catalogs-i18n.git
cd stremio-streaming-catalogs-i18n
npm install
```

Put your TMDB credentials in `.env` (use either `TMDB_API_KEY` (v3) **or**
`TMDB_READ_TOKEN` (v4 Read Access Token)):

```bash
echo 'TMDB_API_KEY=your_v3_key_here' > .env
echo 'CATALOG_LANGUAGE=de' >> .env          # de, fr, es, ja, it, pt, … (default: en)
echo 'PORT=7700' >> .env                     # default: 7700
```

Start it:

```bash
node --env-file=.env index.js
```

The first boot fetches ~7000 TMDB lookups (cold cache) and takes ~1 minute.
**Subsequent boots are near-instant** thanks to the persistent TMDB cache at
`cache/tmdb-id-cache.json`.

Add it to Stremio — point your Stremio client at:

```
http://<your-server-lan-ip>:7700/manifest.json
```

Or with the Stremio protocol handler (works on desktop / Android / iOS):

```
stremio://<your-server-lan-ip>:7700/manifest.json
```

Find your LAN IP with `hostname -I | awk '{print $1}'` (Linux) or `ipconfig`
(Windows). The server binds to `0.0.0.0` by default, so it's reachable from any
device on your network.

> **🔒 Stremio requires HTTPS for addons.** A plain `http://` URL is rejected
> by Stremio. The easiest way to add HTTPS without buying a domain or
> configuring a reverse proxy is to put the server behind a Tailscale network
> and use Tailscale's built-in HTTPS:
>
> ```bash
> # One-time: install Tailscale and set a stable hostname
> curl -fsSL https://tailscale.com/install.sh | sh
> sudo tailscale up
> sudo tailscale set --hostname=stremio-i18n
> sudo tailscale set --accept-dns=true
>
> # Persistent HTTPS proxy: tailscale.ts.net:443 → localhost:7700
> sudo tailscale serve --bg --https=443 --set-path=/ http://localhost:7700
> ```
>
> Then install in Stremio with:
>
> ```
> https://stremio-i18n.<your-tailnet>.ts.net/manifest.json
> ```
>
> This URL works from any device that has Tailscale installed and is logged
> into your account — including phones, TVs, and laptops on different
> networks. The `tailscale serve` command is persistent across reboots.
>
> Find your tailnet name with `tailscale status | head -1` (the part after the
> last `-` in the hostname column).

> **First-boot tip:** if you hit TMDB rate limits (HTTP 429) during the cold
> start, wait a few minutes and re-launch. The cache will be persisted to disk
> on graceful shutdown (SIGTERM/SIGINT), so the second boot will skip all the
> /find lookups that triggered the throttle.

## Supported Streaming Services

- Netflix & Netflix Kids
- Disney+
- HBO Max
- Prime Video
- Apple TV+
- Paramount+
- Peacock Premium
- Hulu
- Curiosity Stream
- MagellanTV
- Crunchyroll
- Hayu
- Clarovideo
- Globoplay
- And many more...

## Local Development Setup

### Prerequisites

- **Node.js** (v16 or higher)
- **npm** or **yarn**

### Installation

1. **Clone the repository**
   ```bash
   git clone https://github.com/rleroi/Stremio-Streaming-Catalogs-Addon.git
   cd Stremio-Streaming-Catalogs-Addon
   ```

2. **Install backend dependencies**
   ```bash
   npm install
   ```

3. **Install frontend dependencies**
   ```bash
   cd vue
   npm install
   cd ..
   ```

### Running Locally

#### Option 1: Development Mode (Recommended)

1. **Start the backend server**
   ```bash
   npm run dev
   ```
   This will start the backend server with nodemon for auto-reloading on changes.

2. **In a new terminal, start the frontend development server**
   ```bash
   cd vue
   npm run dev
   ```
   This will start the Vue development server (typically on http://localhost:5173).

3. **Build the frontend for production**
   ```bash
   cd vue
   npm run build
   cd ..
   ```
   This creates the `vue/dist` folder that the backend serves.

#### Option 2: Production Mode

1. **Build the frontend**
   ```bash
   cd vue
   npm run build
   cd ..
   ```

2. **Start the production server**
   ```bash
   npm start
   ```

### Accessing the Application

### Caching System

The addon includes a caching system to improve performance and reduce API calls:

- **Cache Location**: `./cache/catalog-cache.json`
- **Cache Duration**: 6 hours (configurable)
- **Environment Variables**:
  - `USE_CACHE=true/false` - Enable/disable caching (default: true)
  - `FORCE_REFRESH=true/false` - Force refresh and ignore cache (default: false)

**Development Commands**:
- Clear cache: `curl http://localhost:7700/clear-cache` (development only)
- Force refresh: `FORCE_REFRESH=true npm run dev`

**Benefits**:
- Faster startup times during development
- Reduced API rate limiting
- Consistent data for testing

- **Backend API**: http://localhost:7700
- **Frontend (dev)**: http://localhost:5173 (when running `npm run dev` in vue folder)
- **Production**: http://localhost:7700 (serves the built frontend)

### Environment Variables

The project uses environment variables for configuration. You'll need to set up the following:

#### Backend Environment Variables (Optional)

Create a `.env` file in the root directory for backend configuration:

```env
# Optional: Mixpanel analytics key for tracking
MIXPANEL_KEY=your_mixpanel_key_here

# Optional: Port for the server (default: 7700)
PORT=7700

# Optional: Refresh interval for catalogs in milliseconds (default: 21600000 = 6 hours)
REFRESH_INTERVAL=21600000

# Optional: Set to 'production' for production mode
NODE_ENV=development
```

#### Frontend Environment Variables

The project includes pre-configured environment files in the `vue` directory:

- `vue/.env.development` - Development configuration (points to localhost:7700)
- `vue/.env` - Production configuration

**Note**: The `VITE_APP_URL` is used by the frontend to generate the correct addon installation URL. The included files are already configured for both development and production environments.

### Troubleshooting

#### Server Crashes on Startup

If the backend server crashes during startup (especially during `loadNewCatalog()`), this is likely due to:

1. **Network connectivity issues** - The addon fetches catalogs from external APIs
2. **Rate limiting** - Some APIs may have rate limits
3. **API changes** - External APIs may have changed their endpoints

**Solutions:**
- Check your internet connection
- Wait a few minutes and try again (rate limiting)
- The server will automatically restart with nodemon when you make changes
- For development, you can comment out some of the catalog loading calls in `index.js` to reduce API calls

#### Environment File Issues

- The project includes pre-configured environment files
- If you need to modify the configuration, edit the existing `.env` files
- Restart the servers after changing environment variables

### Development Scripts

#### Backend (Root Directory)
- `npm start` - Start production server
- `npm run dev` - Start development server with auto-reload

#### Frontend (vue Directory)
- `npm run dev` - Start development server with hot reload
- `npm run build` - Build for production
- `npm run preview` - Preview production build

## Project Structure

```
Stremio-Streaming-Catalogs-Addon/
├── index.js              # Main Express server
├── addon.js              # Stremio addon logic
├── package.json          # Backend dependencies
├── vue/                  # Frontend Vue.js application
│   ├── src/
│   │   ├── App.vue       # Main Vue component
│   │   ├── components/   # Vue components
│   │   └── main.js       # Vue app entry point
│   ├── public/           # Static assets
│   ├── dist/             # Built frontend (generated)
│   └── package.json      # Frontend dependencies
└── README.md
```

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

This project is licensed under the ISC License.

## Support

- **Discord**: [Join our Discord server](https://discord.gg/uggmYJ7jVX)
- **Ko-fi**: [Support the project](https://ko-fi.com/rab1t)
