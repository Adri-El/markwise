import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

export async function proxy(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet, headers) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          );
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options),
          );
          Object.entries(headers).forEach(([key, value]) =>
            supabaseResponse.headers.set(key, value),
          );
        },
      },
    },
  );

  const { data } = await supabase.auth.getClaims();
  const signedIn = !!data?.claims?.sub;
  const path = request.nextUrl.pathname;
  const guarded = path.startsWith("/lecturer") || path.startsWith("/student");
  if (guarded && !signedIn) {
    const url = request.nextUrl.clone();
    url.pathname = "/sign-in";
    const redirect = NextResponse.redirect(url);
    supabaseResponse.cookies.getAll().forEach((c) =>
      redirect.cookies.set({ name: c.name, value: c.value }),
    );
    for (const h of ["cache-control", "expires", "pragma"]) {
      const value = supabaseResponse.headers.get(h);
      if (value) redirect.headers.set(h, value);
    }
    return redirect;
  }
  return supabaseResponse;
}

export const config = {
  matcher: ["/lecturer/:path*", "/student/:path*"],
};
