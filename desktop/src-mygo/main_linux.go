package main

import (
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"sync/atomic"

	"github.com/egoist/mygo"
)

func allowedNavigation(raw, devOrigin string) bool {
	u, err := url.Parse(raw)
	if err != nil || u.User != nil {
		return false
	}
	if u.Scheme == "mygo" && u.Host == "localhost" {
		return true
	}
	origin, err := originOf(raw)
	return err == nil && devOrigin != "" && origin == devOrigin
}

func externalHTTP(raw string) bool {
	_, err := originOf(raw)
	return err == nil
}

func main() {
	manager := newBackendManager(defaultTiming)
	mygo.Bind(&Host{backend: manager})
	// Keep the application name stable for mygo's single-instance lock.
	mygo.App.SetName("LDOS")
	if !mygo.App.RequestSingleInstanceLock() {
		return
	}
	var window *mygo.Window
	var quitting atomic.Bool
	mygo.App.OnSecondInstance(func(_ []string, _ string) {
		if window != nil {
			window.Show()
			window.Focus()
		}
	})
	mygo.App.OnBeforeQuit(func(event *mygo.QuitEvent) {
		if quitting.CompareAndSwap(false, true) {
			event.PreventDefault()
			// Leave the UI loop responsive while the Python parent pipe closes
			// and its process group finishes; the second quit then closes it.
			go func() { manager.shutdown(); mygo.App.Quit() }()
		}
	})
	mygo.App.OnQuit(func() { manager.shutdown() })
	mygo.App.WhenReady(func() {
		home, err := os.UserHomeDir()
		if err != nil {
			fmt.Fprintln(os.Stderr, "LDOS: home directory unavailable")
			mygo.App.Quit()
			return
		}
		paths, err := linuxPaths(os.Getenv, home)
		if err != nil {
			fmt.Fprintln(os.Stderr, "LDOS: data directory unavailable")
			mygo.App.Quit()
			return
		}
		mygo.App.SetPath(mygo.PathUserData, filepath.Join(paths.data, "webview"))
		mygo.App.SetPath(mygo.PathCache, paths.cache)
		devOrigin, desktopOrigin, originErr := frontendOrigins(mygo.IsDev(), os.Getenv("MYGO_DEV_URL"))
		window = mygo.NewWindow(mygo.WindowOptions{Title: "LDOS", URL: "/", Width: 1280, Height: 800, MinWidth: 880, MinHeight: 600})
		page := window.Page()
		page.OnWillNavigate(func(event *mygo.NavigateEvent) {
			if allowedNavigation(event.URL, devOrigin) {
				return
			}
			event.PreventDefault()
			if externalHTTP(event.URL) {
				go mygo.Shell.OpenExternal(event.URL)
			}
		})
		page.SetWindowOpenHandler(func(request mygo.WindowOpenRequest) *mygo.WindowOptions {
			if externalHTTP(request.URL) {
				go mygo.Shell.OpenExternal(request.URL)
			}
			return nil
		})
		// No page needs camera, microphone, geolocation or native downloads.
		page.SetPermissionHandler(func(mygo.PermissionRequest) bool { return false })
		page.OnWillDownload(func(event *mygo.DownloadEvent) { event.PreventDefault() })
		manager.start(func() (launchSpec, error) {
			if originErr != nil {
				return launchSpec{}, originErr
			}
			if err := validEnvironment(); err != nil {
				return launchSpec{}, err
			}
			if usesSourceBackend(mygo.IsDev(), os.Getenv) {
				project, err := sourceProjectDir()
				if err != nil {
					return launchSpec{}, err
				}
				return developmentSpec(project, desktopOrigin, os.Getenv)
			}
			resources, err := mygo.App.Path(mygo.PathResources)
			if err != nil {
				return launchSpec{}, errors.New("resources unavailable")
			}
			return packagedSpec(resources, paths, desktopOrigin, os.Getenv)
		})
	})
	// MYGO_GENERATE reaches only Bind/registrations above. WhenReady owns every
	// filesystem mutation, window and backend process, and does not run then.
	if err := mygo.App.Run(); err != nil {
		fmt.Fprintln(os.Stderr, "LDOS: desktop host failed:", err)
	}
	manager.shutdown()
}
