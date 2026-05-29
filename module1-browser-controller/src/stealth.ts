import { Page } from "playwright";
import { IStealthInjector, StealthConfig } from "./types";
import { Logger } from "./logger";

export class StealthInjector implements IStealthInjector {
  constructor(
    private readonly config: StealthConfig,
    private readonly logger: Logger
  ) {}

  async inject(page: unknown, userAgent: string): Promise<void> {
    const p = page as Page;

    await p.addInitScript({
      content: this.buildScript(userAgent),
    });

    this.logger.debug("stealth.injected", undefined, { userAgent });
  }

  private buildScript(userAgent: string): string {
    const vendor = JSON.stringify(this.config.webGLVendor);
    const renderer = JSON.stringify(this.config.webGLRenderer);
    const ua = JSON.stringify(userAgent);

    return `
(function () {
  'use strict';

  /* ── navigator.webdriver ─────────────────────────────────────────────── */
  try {
    Object.defineProperty(navigator, 'webdriver', {
      get: () => undefined,
      configurable: true,
    });
  } catch (_) {}

  /* ── navigator.userAgent ─────────────────────────────────────────────── */
  try {
    Object.defineProperty(navigator, 'userAgent', {
      get: () => ${ua},
      configurable: true,
    });
  } catch (_) {}

  /* ── navigator.plugins (non-empty so we look like a real browser) ────── */
  try {
    Object.defineProperty(navigator, 'plugins', {
      get: () => {
        const arr = [
          { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
          { name: 'Chrome PDF Viewer',  filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
          { name: 'Native Client',      filename: 'internal-nacl-plugin',              description: '' },
        ];
        Object.defineProperty(arr, 'item',   { value: (i) => arr[i] });
        Object.defineProperty(arr, 'namedItem', { value: (n) => arr.find(p => p.name === n) ?? null });
        return arr;
      },
      configurable: true,
    });
  } catch (_) {}

  /* ── navigator.languages ─────────────────────────────────────────────── */
  try {
    Object.defineProperty(navigator, 'languages', {
      get: () => ['en-US', 'en'],
      configurable: true,
    });
  } catch (_) {}

  /* ── Canvas fingerprint noise ────────────────────────────────────────── */
  ${this.config.spoofCanvas ? StealthInjector.canvasNoise() : "/* canvas spoofing disabled */"}

  /* ── WebGL renderer / vendor spoofing ────────────────────────────────── */
  ${StealthInjector.webGLSpoof(vendor, renderer)}

  /* ── window.chrome presence ─────────────────────────────────────────── */
  try {
    if (!window.chrome) {
      Object.defineProperty(window, 'chrome', {
        value: { runtime: {} },
        writable: false,
        configurable: true,
      });
    }
  } catch (_) {}

})();
`;
  }

  private static canvasNoise(): string {
    return `
  (function () {
    /* Deterministic-per-session noise seeded from a random salt so repeated
       reads by the same fingerprinting script return the same noisy value,
       but differ across sessions.                                            */
    const SALT = Math.random();

    function noiseByte(index) {
      /* xorshift-based cheap deterministic hash */
      let x = (index ^ (SALT * 0xffffffff)) >>> 0;
      x ^= x << 13; x ^= x >> 17; x ^= x << 5;
      return (x >>> 0) % 4; /* 0-3 LSB noise */
    }

    const origGetContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, ...args) {
      const ctx = origGetContext.apply(this, [type, ...args]);
      if (type !== '2d' || !ctx) return ctx;

      const origGetImageData = ctx.getImageData.bind(ctx);
      ctx.getImageData = function (sx, sy, sw, sh) {
        const data = origGetImageData(sx, sy, sw, sh);
        for (let i = 0; i < data.data.length; i += 4) {
          data.data[i]     = Math.min(255, data.data[i]     + noiseByte(i));
          data.data[i + 1] = Math.min(255, data.data[i + 1] + noiseByte(i + 1));
          data.data[i + 2] = Math.min(255, data.data[i + 2] + noiseByte(i + 2));
        }
        return data;
      };
      return ctx;
    };

    const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function (...args) {
      const ctx = origGetContext.call(this, '2d');
      if (ctx) {
        const w = this.width, h = this.height;
        if (w > 0 && h > 0) {
          const img = ctx.getImageData(0, 0, w, h);  /* already noisy via override */
          ctx.putImageData(img, 0, 0);
        }
      }
      return origToDataURL.apply(this, args);
    };
  })();
`;
  }

  private static webGLSpoof(vendor: string, renderer: string): string {
    return `
  (function () {
    const VENDOR_EXT   = 37445; /* UNMASKED_VENDOR_WEBGL   */
    const RENDERER_EXT = 37446; /* UNMASKED_RENDERER_WEBGL */

    function patchContext(ctor) {
      if (!ctor) return;
      const orig = ctor.prototype.getParameter;
      ctor.prototype.getParameter = function (param) {
        if (param === VENDOR_EXT)   return ${vendor};
        if (param === RENDERER_EXT) return ${renderer};
        return orig.call(this, param);
      };

      const origGetExtension = ctor.prototype.getExtension;
      ctor.prototype.getExtension = function (name) {
        if (name === 'WEBGL_debug_renderer_info') {
          return {
            UNMASKED_VENDOR_WEBGL:   VENDOR_EXT,
            UNMASKED_RENDERER_WEBGL: RENDERER_EXT,
          };
        }
        return origGetExtension.call(this, name);
      };
    }

    try { patchContext(WebGLRenderingContext);       } catch (_) {}
    try { patchContext(WebGL2RenderingContext);      } catch (_) {}
  })();
`;
  }
}
