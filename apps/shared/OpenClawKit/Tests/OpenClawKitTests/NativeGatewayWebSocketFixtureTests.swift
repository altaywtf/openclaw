#if os(macOS)
import Foundation
import Synchronization
import Testing

@Suite(.serialized)
struct NativeGatewayWebSocketFixtureTests {
    @Test
    @MainActor
    func `network callbacks progress without MainActor and stop closes clients`() async throws {
        let fixture = try await NativeGatewayWebSocketFixture.start(issuedDeviceTokens: [])
        defer { fixture.stop() }
        let session = URLSession(configuration: .ephemeral)
        defer { session.invalidateAndCancel() }
        let socket = session.webSocketTask(with: fixture.url())
        defer { socket.cancel(with: .goingAway, reason: nil) }
        let response = Mutex<Result<URLSessionWebSocketTask.Message, any Error>?>(nil)
        let received = DispatchSemaphore(value: 0)
        // Deliberately block MainActor while the real HTTP upgrade and challenge
        // complete. A fixture that schedules network callbacks there deadlocks.
        let completed = await withCheckedContinuation { continuation in
            DispatchQueue.main.async {
                socket.resume()
                socket.receive { result in
                    response.withLock { $0 = result }
                    received.signal()
                }
                continuation.resume(returning: received.wait(timeout: .now() + 5) == .success)
            }
        }
        #expect(completed)
        let result = try #require(response.withLock { $0 })
        guard case let .string(message) = try result.get() else {
            Issue.record("expected a text challenge")
            return
        }
        #expect(message.contains("connect.challenge"))
        #expect(fixture.activeConnectionCount == 1)
        fixture.stop()
        fixture.stop()
        #expect(fixture.activeConnectionCount == 0)
        await #expect(throws: (any Error).self) {
            try await socket.receive()
        }
    }

    @Test
    @MainActor
    func `cancelled startup does not publish a listener`() async throws {
        let startup = Task {
            try await NativeGatewayWebSocketFixture.start(issuedDeviceTokens: [])
        }
        startup.cancel()
        await #expect(throws: CancellationError.self) {
            try await startup.value
        }
    }
}
#endif
