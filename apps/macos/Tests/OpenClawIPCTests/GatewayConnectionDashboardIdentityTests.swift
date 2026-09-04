import AppKit
import ConcurrencyExtras
import Foundation
import Testing
@testable import OpenClaw
@testable import OpenClawKit

private struct DashboardIdentityFixture: Sendable {
    let config: GatewayConnection.Config
    let source: GatewayConnectionEndpointSource
    let announcement: LockIsolated<String?>
    let requests: LockIsolated<[String]>
    let suspendEndpoint: LockIsolated<Bool>
    let connection: GatewayConnection
    let session: GatewayTestWebSocketSession

    init(announcement: String?, endpointGate: GatewayConnectionSuspensionGate? = nil) throws {
        let config: GatewayConnection.Config = try (
            #require(URL(string: "ws://127.0.0.1:28901")), "synthetic-owner-token", nil)
        let source = GatewayConnectionEndpointSource(endpoint: .init(
            config: config, routeAuthority: 1, revision: 1))
        let announcement = LockIsolated(announcement)
        let requests = LockIsolated<[String]>([])
        let suspendEndpoint = LockIsolated(false)
        let session = GatewayTestWebSocketSession(taskFactory: {
            GatewayTestWebSocketTask(sendHook: { socket, message, sendIndex in
                guard sendIndex > 0, let id = GatewayWebSocketTestSupport.requestID(from: message) else { return }
                let data: Data = switch message {
                case let .data(data): data
                case let .string(string): Data(string.utf8)
                @unknown default: Data()
                }
                let frame = try JSONSerialization.jsonObject(with: data) as? [String: Any]
                let method = try #require(frame?["method"] as? String)
                requests.withValue { $0.append(method) }
                socket.emitReceiveSuccess(.data(GatewayWebSocketTestSupport.okResponseData(id: id)))
            }, receiveHook: { socket, index in
                if index == 0 { return .data(GatewayWebSocketTestSupport.connectChallengeData()) }
                let data = GatewayWebSocketTestSupport.connectOkData(id: socket.snapshotConnectRequestID() ?? "connect")
                guard let identityURL = announcement.value else { return .data(data) }
                var frame = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
                var payload = try #require(frame["payload"] as? [String: Any])
                var snapshot = try #require(payload["snapshot"] as? [String: Any])
                snapshot["controlUiIdentityUrl"] = identityURL
                payload["snapshot"] = snapshot
                frame["payload"] = payload
                return try .data(JSONSerialization.data(withJSONObject: frame))
            })
        })
        self.config = config
        self.source = source
        self.announcement = announcement
        self.requests = requests
        self.suspendEndpoint = suspendEndpoint
        self.session = session
        self.connection = GatewayConnection(
            testEndpointProvider: {
                if suspendEndpoint.value { await endpointGate?.suspend() }
                return source.snapshot()
            },
            currentEndpointRevision: { source.snapshot().revision! },
            sessionBox: WebSocketSessionBox(session: session))
    }
}

@Suite(.serialized)
struct GatewayConnectionDashboardIdentityTests {
    @Test(arguments: [nil, "https://team.example.test/", "https://renewed.example.test/"])
    @MainActor
    func `open saved profile windows follow their native connection identity`(announcement: String?) async throws {
        try await TestIsolation.withIsolatedState {
            _ = AppKitTestSupport.application
            let originalURL = try #require(URL(string: "https://team.example.test/"))
            let fixture = try DashboardIdentityFixture(announcement: originalURL.absoluteString)
            let target = DashboardGatewayTarget.profile("identity-reconnect")
            let manager = DashboardManager._testMake(
                connectionProvider: { _ in fixture.connection },
                browserIdentityURLProvider: nil,
                observeGatewayChanges: true,
                profileEndpointProvider: { _ in fixture.source.snapshot() },
                gatewayEntriesProvider: {
                    [DashboardGatewayEntry(
                        id: target.bridgeID,
                        name: "Saved Gateway",
                        kind: "remote",
                        isPrimary: false,
                        canPromote: true,
                        health: .unknown)]
                })
            let result: Result<Void, Error>
            do {
                await manager._testOpenWindow(for: target)
                await manager._testOpenWindow(for: target)
                let originals = manager._testAuxiliaryWindows().map(\.controller)
                try #require(originals.count == 2)
                let windows = originals.compactMap(\.window)
                try #require(windows.count == 2)
                try #require(originals.allSatisfy { $0.currentURL == originalURL && $0.auth.usesBrowserIdentity })
                let lease = try #require(await fixture.connection.captureServerLease())

                // Serve withdraws its announcement before retiring connections that received it.
                fixture.announcement.withValue { $0 = announcement }
                fixture.session.latestTask()?.emitReceiveFailure()
                let retired = ContinuousClock.now + .seconds(3)
                while await fixture.connection.isCurrentServerLease(lease), ContinuousClock.now < retired {
                    try await Task.sleep(for: .milliseconds(10))
                }
                try #require(await fixture.connection.isCurrentServerLease(lease) == false)
                _ = try await fixture.connection.request(method: "health", params: nil)
                try #require(try await fixture.connection.controlUiBrowserIdentityURL(config: fixture.config)?
                    .absoluteString == announcement)

                let expectedURL = try announcement.flatMap(URL.init(string:)) ?? GatewayEndpointStore.dashboardURL(
                    for: fixture.config, mode: .remote, authToken: fixture.config.token)
                let unchanged = announcement == originalURL.absoluteString
                let refreshed = ContinuousClock.now + .seconds(5)
                while unchanged || manager._testAuxiliaryWindows().contains(where: {
                    $0.controller.currentURL != expectedURL
                }),
                    ContinuousClock.now < refreshed
                {
                    try await Task.sleep(for: .milliseconds(10))
                }
                let current = manager._testAuxiliaryWindows()
                #expect(current.count == 2)
                #expect(current.allSatisfy { $0.target == target && $0.controller.currentURL == expectedURL })
                #expect(current.allSatisfy { instance in windows.contains { $0 === instance.controller.window } })
                #expect(current.allSatisfy { $0.controller.auth.usesBrowserIdentity == (announcement != nil) })
                #expect(current
                    .allSatisfy { $0.controller.auth.token == (announcement == nil ? fixture.config.token : nil) })
                #expect(current.allSatisfy { instance in
                    originals.contains { $0 === instance.controller } == unchanged
                })
                result = .success(())
            } catch {
                result = .failure(error)
            }
            manager.close()
            await fixture.connection.shutdown()
            try result.get()
        }
    }

    @Test(arguments: [nil, "https://team.example.test/", "https://team.example.test/team/"])
    func `first open reads the authenticated hello without admin discovery RPCs`(announcement: String?) async throws {
        let fixture = try DashboardIdentityFixture(announcement: announcement)
        #expect(try await fixture.connection.controlUiBrowserIdentityURL(config: fixture.config)?.absoluteString ==
            announcement)
        #expect(try await fixture.connection.controlUiBrowserIdentityURL(config: fixture.config)?.absoluteString ==
            announcement)
        #expect(fixture.requests.value == ["health"])
        await fixture.connection.shutdown()
    }

    @Test(arguments: [
        "http://team.example.test", "https://user@team.example.test",
        "https://team.example.test?token=secret", "https://team.example.test#token=secret",
    ])
    func `invalid advertised identities fail instead of silently using owner`(announcement: String) async throws {
        let fixture = try DashboardIdentityFixture(announcement: announcement)
        await #expect(throws: URLError.self) {
            try await fixture.connection.controlUiBrowserIdentityURL(config: fixture.config)
        }
        await fixture.connection.shutdown()
    }

    @Test func `a mismatched caller config cannot connect to or borrow the selected Gateway`() async throws {
        let fixture = try DashboardIdentityFixture(announcement: "https://team.example.test/")
        let mismatched: GatewayConnection.Config = (fixture.config.url, "different-owner-token", nil)
        await #expect(throws: CancellationError.self) {
            try await fixture.connection.controlUiBrowserIdentityURL(config: mismatched)
        }
        #expect(fixture.requests.value.isEmpty)
        #expect(fixture.session.snapshotMakeCount() == 0)
        await fixture.connection.shutdown()
    }

    @Test func `a suspended lookup cannot return a replacement Gateway identity`() async throws {
        let gate = GatewayConnectionSuspensionGate()
        let fixture = try DashboardIdentityFixture(
            announcement: "https://team.example.test/", endpointGate: gate)
        #expect(try await fixture.connection.controlUiBrowserIdentityURL(config: fixture.config)?.absoluteString ==
            "https://team.example.test/")
        fixture.suspendEndpoint.withValue { $0 = true }
        let pending = Task { try await fixture.connection.controlUiBrowserIdentityURL(config: fixture.config) }
        await gate.waitUntilStarted()
        let replacement: GatewayConnection.Config = try (
            #require(URL(string: "ws://127.0.0.1:28902")), fixture.config.token, nil)
        fixture.source.setEndpoint(.init(config: replacement, routeAuthority: 2, revision: 2))
        fixture.announcement.withValue { $0 = "https://second.example.test/" }
        await gate.open()
        await #expect(throws: CancellationError.self) { try await pending.value }
        #expect(try await fixture.connection.controlUiBrowserIdentityURL(config: replacement)?.absoluteString ==
            "https://second.example.test/")
        #expect(fixture.requests.value == ["health", "health"])
        await fixture.connection.shutdown()
    }

    @Test(arguments: [nil, "https://renewed.example.test/"])
    func `reconnect at the same address replaces the advertised identity`(announcement: String?) async throws {
        let fixture = try DashboardIdentityFixture(announcement: "https://team.example.test/")
        #expect(try await fixture.connection.controlUiBrowserIdentityURL(config: fixture.config)?.absoluteString ==
            "https://team.example.test/")
        let lease = try #require(await fixture.connection.captureServerLease())
        fixture.announcement.withValue { $0 = announcement }
        fixture.session.latestTask()?.emitReceiveFailure()
        let deadline = ContinuousClock.now + .seconds(2)
        while await fixture.connection.isCurrentServerLease(lease), ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(10))
        }
        #expect(await fixture.connection.isCurrentServerLease(lease) == false)
        #expect(try await fixture.connection.controlUiBrowserIdentityURL(config: fixture.config)?.absoluteString ==
            announcement)
        #expect(fixture.requests.value == ["health", "health"])
        await fixture.connection.shutdown()
    }
}
