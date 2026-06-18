/**
 * Vercel Edge Middleware: редирект Android-телефонов на ANDROID_REDIRECT_URL.
 * Переменные задавайте в Vercel → Settings → Environment Variables.
 *
 * ANDROID_REDIRECT_ENABLED=true
 * ANDROID_REDIRECT_URL=https://example.com
 */

export const config = {
  matcher: [
    '/((?!_astro/|images/|avatars/|favicon|robots|ads|sitemap|.*\\.(?:svg|jpg|jpeg|png|webp|ico|txt|xml|js|css|woff2?)$).*)',
  ],
};

function isAndroidMobile(userAgent) {
  if (!userAgent) return false;
  // Телефоны: Android + Mobile; планшеты обычно без Mobile — их не трогаем
  return /Android/i.test(userAgent) && /Mobile/i.test(userAgent);
}

export default function middleware(request) {
  const enabled =
    process.env.ANDROID_REDIRECT_ENABLED === 'true' ||
    process.env.PUBLIC_ANDROID_REDIRECT_ENABLED === 'true';

  const targetUrl =
    process.env.ANDROID_REDIRECT_URL || process.env.PUBLIC_ANDROID_REDIRECT_URL;

  if (!enabled || !targetUrl) {
    return;
  }

  let destination;
  try {
    destination = new URL(targetUrl);
  } catch {
    return;
  }

  const userAgent = request.headers.get('user-agent') || '';
  if (!isAndroidMobile(userAgent)) {
    return;
  }

  return Response.redirect(destination.toString(), 302);
}
