import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
  integrations: [
    starlight({
      title: 'OctaP SDK',
      defaultLocale: 'root',
      locales: {
        root: { label: 'English', lang: 'en' },
        vi: { label: 'Tiếng Việt', lang: 'vi' },
      },
      description: 'Add OctaP loyalty points and vouchers to a merchant backend and website.',
      favicon: '/favicon.svg',
      logo: {
        light: './src/assets/logo_light.png',
        dark: './src/assets/logo_dark.png',
        alt: 'OctaP',
        replacesTitle: false,
      },
      customCss: ['./src/styles/octap.css'],
      head: [
        { tag: 'link', attrs: { rel: 'preconnect', href: 'https://fonts.googleapis.com' } },
        { tag: 'link', attrs: { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: true } },
        {
          tag: 'link',
          attrs: {
            rel: 'stylesheet',
            href: 'https://fonts.googleapis.com/css2?family=Google+Sans:wght@400;500;600;700&display=swap',
          },
        },
      ],
      expressiveCode: {
        themes: ['github-light', 'github-dark'],
        styleOverrides: {
          borderRadius: '0.5rem',
          codeFontSize: '0.8125rem',
          frames: { frameBoxShadowCssValue: 'none' },
        },
      },
      tableOfContents: { minHeadingLevel: 2, maxHeadingLevel: 3 },
      lastUpdated: false,
      pagination: true,
      sidebar: [
        {
          label: 'Get started',
          translations: { vi: 'Bắt đầu' },
          items: [
            { label: 'Overview', translations: { vi: 'Tổng quan' }, slug: 'index' },
            { label: 'Installation', translations: { vi: 'Cài đặt' }, slug: 'get-started/installation' },
            {
              label: 'Backend quickstart',
              translations: { vi: 'Quickstart cho backend' },
              slug: 'get-started/backend-quickstart',
            },
            {
              label: 'Frontend quickstart',
              translations: { vi: 'Quickstart cho frontend' },
              slug: 'get-started/frontend-quickstart',
            },
            { label: 'Run it locally', translations: { vi: 'Chạy thử trên máy' }, slug: 'get-started/run-locally' },
          ],
        },
        {
          label: 'Concepts',
          translations: { vi: 'Khái niệm' },
          items: [
            {
              label: 'How OctaP works',
              translations: { vi: 'Cách OctaP hoạt động' },
              slug: 'concepts/how-octap-works',
            },
            {
              label: 'API keys and scopes',
              translations: { vi: 'API key và scope' },
              slug: 'concepts/api-keys-and-scopes',
            },
            { label: 'Points lifecycle', translations: { vi: 'Vòng đời điểm' }, slug: 'concepts/points-lifecycle' },
            { label: 'Issuance budget', translations: { vi: 'Ngân sách phát hành' }, slug: 'concepts/issuance-budget' },
            {
              label: 'Idempotency and recovery',
              translations: { vi: 'Idempotency và phục hồi' },
              slug: 'concepts/idempotency-and-recovery',
            },
          ],
        },
        {
          label: 'Guides',
          translations: { vi: 'Hướng dẫn' },
          items: [
            {
              label: 'Verify a customer',
              translations: { vi: 'Xác minh khách hàng' },
              slug: 'guides/verify-a-customer',
            },
            {
              label: 'Earn and reverse points',
              translations: { vi: 'Earn và đảo điểm' },
              slug: 'guides/earn-and-reverse-points',
            },
            {
              label: 'Claim a paid voucher',
              translations: { vi: 'Claim voucher trả phí' },
              slug: 'guides/claim-a-paid-voucher',
            },
            {
              label: 'Redeem points at checkout',
              translations: { vi: 'Redeem điểm khi thanh toán' },
              slug: 'guides/redeem-points-at-checkout',
            },
            { label: 'Manage vouchers', translations: { vi: 'Quản lý voucher' }, slug: 'guides/manage-vouchers' },
            { label: 'Receive webhooks', translations: { vi: 'Nhận webhook' }, slug: 'guides/receive-webhooks' },
          ],
        },
        {
          label: 'Node SDK reference',
          translations: { vi: 'Tham chiếu Node SDK' },
          items: [
            { label: 'Client', slug: 'reference/node/client' },
            {
              label: 'Identity and credits',
              translations: { vi: 'Định danh và credits' },
              slug: 'reference/node/credits',
            },
            { label: 'Vouchers', translations: { vi: 'Voucher' }, slug: 'reference/node/vouchers' },
            { label: 'Webhooks', slug: 'reference/node/webhooks' },
            { label: 'Errors', translations: { vi: 'Lỗi' }, slug: 'reference/node/errors' },
          ],
        },
        {
          label: 'Browser SDK reference',
          translations: { vi: 'Tham chiếu Browser SDK' },
          items: [
            { label: 'OctapAuth', slug: 'reference/browser/octap-auth' },
            { label: 'Errors', translations: { vi: 'Lỗi' }, slug: 'reference/browser/errors' },
          ],
        },
        {
          label: 'Shared reference',
          translations: { vi: 'Tham chiếu chung' },
          items: [
            { label: 'Webhook events', slug: 'reference/webhook-events' },
            { label: 'Status values', translations: { vi: 'Các giá trị trạng thái' }, slug: 'reference/status-values' },
          ],
        },
      ],
    }),
  ],
});
