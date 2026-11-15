import { useEffect, type ReactNode } from "react";
import { Navigate, Route, Routes, useLocation, useNavigate } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { api, setUnauthorizedHandler } from "./api/client";
import { usePerspectives, useSettings } from "./api/queries";
import { QuickEntryFromUrl, Shell } from "./components/Shell";
import { Toasts } from "./components/Toasts";
import { applyTheme } from "./lib/theme";
import { perspectivePath, sortPerspectives } from "./lib/perspectives";
import { AuthorizePage, EnrollPage, LoginPage } from "./pages/AuthPages";
import { PerspectivePage, CustomPerspectivePage } from "./pages/PerspectivePage";
import { ForecastPage } from "./pages/ForecastPage";
import { ReviewPage } from "./pages/ReviewPage";
import { SearchPage } from "./pages/SearchPage";
import { PerspectiveEditorPage } from "./pages/PerspectiveEditor";
import { SettingsPage } from "./pages/SettingsPage";

function RequireAuth({ children }: { children: ReactNode }) {
  const location = useLocation();
  const session = useQuery({
    queryKey: ["session"],
    queryFn: () => api.get<{ authenticated: boolean }>("/auth/session", undefined, { allowUnauthorized: true }),
    retry: false,
    staleTime: 5 * 60_000,
  });
  if (session.isPending) {
    return <div className="flex h-full items-center justify-center text-muted" aria-busy="true">Loading…</div>;
  }
  if (session.isError || !session.data?.authenticated) {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }
  return <>{children}</>;
}

function ThemeFromSettings() {
  const { data } = useSettings();
  useEffect(() => {
    if (data) applyTheme(data.theme);
  }, [data]);
  return null;
}

/** Redirect that keeps the query string (for `?quickEntry=1`). */
function RedirectKeepingSearch({ to }: { to: string }) {
  const { search } = useLocation();
  return <Navigate to={{ pathname: to, search }} replace />;
}

function HomeRedirect() {
  const { data } = usePerspectives();
  if (!data) return null;
  const first = sortPerspectives(data).find((p) => p.favorite && p.id !== "search");
  return <RedirectKeepingSearch to={first ? perspectivePath(first) : "/inbox"} />;
}

export function App() {
  const navigate = useNavigate();
  useEffect(() => {
    setUnauthorizedHandler(() => {
      if (!/^\/(login|enroll)/.test(window.location.pathname)) {
        navigate("/login", { replace: true, state: { from: window.location.pathname + window.location.search } });
      }
    });
  }, [navigate]);

  return (
    <>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/enroll" element={<EnrollPage />} />
        <Route
          path="/authorize"
          element={
            <RequireAuth>
              <AuthorizePage />
            </RequireAuth>
          }
        />
        <Route
          element={
            <RequireAuth>
              <ThemeFromSettings />
              <Shell />
            </RequireAuth>
          }
        >
          <Route index element={<HomeRedirect />} />
          <Route element={<QuickEntryFromUrl />}>
            <Route path="inbox" element={<PerspectivePage id="inbox" />} />
            <Route path="projects" element={<PerspectivePage id="projects" />} />
            <Route path="tags" element={<PerspectivePage id="tags" />} />
            <Route path="flagged" element={<PerspectivePage id="flagged" />} />
            <Route path="review" element={<ReviewPage />} />
            <Route path="completed" element={<PerspectivePage id="completed" />} />
            <Route path="changed" element={<PerspectivePage id="changed" />} />
            <Route path="forecast" element={<ForecastPage />} />
            <Route path="search" element={<SearchPage />} />
            <Route path="perspectives/:id" element={<CustomPerspectivePage />} />
            <Route path="perspectives/:id/edit" element={<PerspectiveEditorPage />} />
            <Route path="settings" element={<SettingsPage />} />
          </Route>
          <Route path="*" element={<RedirectKeepingSearch to="/" />} />
        </Route>
      </Routes>
      <Toasts />
    </>
  );
}
