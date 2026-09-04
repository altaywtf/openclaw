import Foundation
import OpenClawKit
import Testing
@testable import OpenClaw

private actor DashboardReconnectAuthGate {
    private var token: String?

    func authToken() -> String? {
        self.token
    }

    func replaceToken(_ token: String) {
        self.token = token
    }
}

@Suite(.serialized)
@MainActor
struct DashboardReconnectTests {
    @Test func `reopening personal sign in does not inherit the native websocket TLS policy`() async throws {
        let server = try await DashboardHTTPFixture.start()
        defer { server.stop() }
        let state = AppStateStore.shared
        let originalMode = state.connectionMode
        state.connectionMode = .remote
        defer { state.connectionMode = originalMode }
        let identityURL = server.url("/dashboard/")
        let nativeURL = try #require(URL(string: "wss://native.example.test:443/"))
        let nativeTLS = GatewayTLSParams(
            required: true, expectedFingerprint: String(repeating: "a", count: 64),
            allowTOFU: false, storeKey: "fixture-native")
        let manager = DashboardManager._testMake(
            browserIdentityURLProvider: { _, _ in identityURL },
            primaryEndpointProvider: { _ in
                GatewayConnection.EndpointSnapshot(
                    config: (nativeURL, "native-owner-token", nil),
                    tls: GatewayTLSRoute(params: nativeTLS, allowsTrustedPinReplacement: false),
                    routeAuthority: 1, revision: 1)
            })
        defer { manager.close() }
        try await manager.show()
        let first = try #require(manager._testController())
        let loginURL = server.url("/login")
        first.webView.load(URLRequest(url: loginURL))
        let deadline = ContinuousClock.now + .seconds(10)
        while !first.canDeliverNativeCommands || first.webView.isLoading || first.webView.url != loginURL,
              ContinuousClock.now < deadline
        {
            try await Task.sleep(for: .milliseconds(20))
        }
        #expect(first.webView.url == loginURL)
        #expect(!first.webView.isLoading)
        try await manager.show()
        let reopened = try #require(manager._testController())
        #expect(reopened === first)
        #expect(reopened.webView.url == loginURL)
        #expect(reopened.hasTLSParams(nil))
        #expect(reopened.auth.usesBrowserIdentity)
    }

    @Test func `remote dashboard uses verified browser identity across tunnel reconnects`() async throws {
        let server = try await DashboardHTTPFixture.start()
        defer { server.stop() }
        let identityURL = try #require(URL(string: "https://team.example/dashboard/"))
        let controller = DashboardWindowController(
            url: server.url("/"),
            auth: DashboardWindowAuth(
                gatewayUrl: server.websocketURL("/").absoluteString,
                token: "shared-owner-token",
                password: nil),
            websiteDataStore: .nonPersistent(),
            windowAutosaveName: "OpenClawDashboardWindow-Test-\(UUID().uuidString)",
            requestBrowserProfileImportOffer: { _ in false })
        controller.show()
        let manager = DashboardManager._testMake(browserIdentityURLProvider: { _, _ in identityURL })
        manager._testSetController(controller)
        defer { manager.close() }

        await manager.handleEndpointState(.ready(
            mode: .remote, url: server.websocketURL("/"), token: "shared-owner-token",
            password: "shared-password", routeRevision: 1))

        let identified = try #require(manager._testController())
        #expect(identified.currentURL == identityURL)
        #expect(identified.auth == .browserIdentity(gatewayUrl: "wss://team.example/dashboard/"))
        #expect(identified.auth.token == nil)
        #expect(identified.auth.password == nil)
        #expect(identified.hasTLSParams(nil))

        let nextTunnel = try #require(URL(string: "ws://127.0.0.1:29876"))
        await manager.handleEndpointState(.ready(
            mode: .remote, url: nextTunnel, token: "next-owner-token",
            password: nil, routeRevision: 2))

        let reconnected = try #require(manager._testController())
        #expect(reconnected.currentURL == identityURL)
        #expect(reconnected.auth == identified.auth)
    }

    @Test func `authenticated control reconnect recovers unchanged ready route`() async throws {
        let server = try await DashboardHTTPFixture.start()
        defer { server.stop() }
        let replacementServer = try await DashboardHTTPFixture.start()
        defer { replacementServer.stop() }
        let url = server.url("/#token=route-a-device-token")
        let controller = DashboardWindowController(
            url: url,
            auth: DashboardWindowAuth(
                gatewayUrl: server.websocketURL("/").absoluteString,
                token: "route-a-device-token",
                password: nil),
            websiteDataStore: .nonPersistent(),
            windowAutosaveName: "OpenClawDashboardWindow-Test-\(UUID().uuidString)",
            requestBrowserProfileImportOffer: { _ in false })
        defer { controller.closeDashboard() }
        controller.show()
        let authGate = DashboardReconnectAuthGate()
        let socketURL = replacementServer.websocketURL("")
        let endpointState = GatewayEndpointState.ready(
            mode: .remote,
            url: socketURL,
            token: nil,
            password: nil,
            routeRevision: 2)
        let manager = DashboardManager._testMake(
            authTokenProvider: { _ in await authGate.authToken() },
            endpointStateProvider: { endpointState })
        manager._testSetController(controller)
        defer { manager._testController()?.closeDashboard() }

        await manager.handleEndpointState(endpointState)
        let failureController = try #require(manager._testController())
        #expect(failureController !== controller)
        #expect(failureController.currentURL == URL(string: "about:blank"))

        await manager.handleEndpointState(endpointState)
        #expect(manager._testController() === failureController)

        await authGate.replaceToken("route-b-device-token")
        await manager._testHandleControlChannelStateChange(.connecting)
        #expect(manager._testController() === failureController)

        await manager._testHandleControlChannelStateChange(.connected)

        let recoveredController = try #require(manager._testController())
        #expect(recoveredController !== failureController)
        #expect(!failureController.isWindowOpen)
        #expect(recoveredController.currentURL.absoluteString ==
            replacementServer.url("/#token=route-b-device-token").absoluteString)
    }
}
