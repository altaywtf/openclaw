package ai.openclaw.app.voice

import ai.openclaw.app.gateway.GatewaySession
import ai.openclaw.app.i18n.nativeText
import ai.openclaw.app.i18n.resolveNativeText
import android.content.Context
import android.media.AudioDeviceInfo
import android.media.AudioManager
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.AudioDeviceInfoBuilder

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class TalkRealtimeClientTest {
  @Test
  fun forwardsTheSavedMicrophoneToThePeerAndResolvesOnlyAvailableInputs() =
    runTest {
      Dispatchers.setMain(UnconfinedTestDispatcher(testScheduler))
      val context = RuntimeEnvironment.getApplication()
      val manager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
      val microphone = AudioDeviceInfoBuilder.newBuilder().setType(AudioDeviceInfo.TYPE_USB_DEVICE).build()
      shadowOf(manager).setInputDevices(listOf(microphone))
      var selected: String? = audioInputDeviceKey(microphone)
      val lease = GatewaySession.RequestLease("fixture", requestImpl = { _, _, _, _ -> "{}" })
      val client = TalkRealtimeClient(context, this, lease, "main", {}, { _, _, _ -> }, {}, { selected })
      try {
        val peer =
          client.javaClass
            .getDeclaredField("peer")
            .apply { isAccessible = true }
            .get(client)
        val resolve = peer.javaClass.getDeclaredMethod("resolvePreferredInput").apply { isAccessible = true }
        assertEquals(microphone, resolve.invoke(peer))
        selected = null
        assertNull(resolve.invoke(peer))
        selected = audioInputDeviceKey(microphone)
        shadowOf(manager).setInputDevices(emptyList())
        assertNull(resolve.invoke(peer))
      } finally {
        client.close()
        shadowOf(manager).setInputDevices(emptyList())
        Dispatchers.resetMain()
      }
    }

  @Test
  fun transcriptRequestsMatchTheGatewayProtocolFixture() =
    runTest {
      Dispatchers.setMain(UnconfinedTestDispatcher(testScheduler))
      val fixture = javaClass.getResourceAsStream("/talk-transcript-protocol.json")!!.bufferedReader().use { Json.parseToJsonElement(it.readText()).jsonObject }
      val requests = mutableListOf<JsonObject>()
      val lease =
        GatewaySession.RequestLease("fixture", requestImpl = { method, params, _, _ ->
          if (method == "talk.client.transcript") requests.add(Json.parseToJsonElement(checkNotNull(params)).jsonObject)
          "{}"
        })
      val client = TalkRealtimeClient(RuntimeEnvironment.getApplication(), this, lease, "main", {}, { _, _, _ -> }, {})
      try {
        client.javaClass
          .getDeclaredField("voiceSessionId")
          .apply { isAccessible = true }
          .set(client, "voice-fixture")
        val event = client.javaClass.getDeclaredMethod("handleProviderEvent", String::class.java).apply { isAccessible = true }
        for (payload in fixture.getValue("events").jsonArray) event.invoke(client, payload.toString())
        runCurrent()
        assertEquals(fixture.getValue("requests"), JsonArray(requests))
      } finally {
        client.close()
        Dispatchers.resetMain()
      }
    }

  @Test
  fun completedEmptyResponseReturnsToListeningButNotOverAReplacementOrPlayback() =
    runTest {
      Dispatchers.setMain(UnconfinedTestDispatcher(testScheduler))
      val states = mutableListOf<String>()
      val lease = GatewaySession.RequestLease("fixture", requestImpl = { _, _, _, _ -> "{}" })
      val client = TalkRealtimeClient(RuntimeEnvironment.getApplication(), this, lease, "main", { states.add(it) }, { _, _, _ -> }, {})
      try {
        val event = client.javaClass.getDeclaredMethod("handleProviderEvent", String::class.java).apply { isAccessible = true }
        event.invoke(client, """{"type":"response.created","response":{"id":"first"}}""")
        event.invoke(client, """{"type":"response.done","response":{"id":"first","status":"completed","output":[]}}""")
        assertEquals("Listening", states.last())
        event.invoke(client, """{"type":"response.created","response":{"id":"old"}}""")
        event.invoke(client, """{"type":"response.created","response":{"id":"replacement"}}""")
        event.invoke(client, """{"type":"response.done","response":{"id":"old","status":"completed","output":[]}}""")
        assertEquals("Thinking", states.last())
        event.invoke(client, """{"type":"output_audio_buffer.cleared","response_id":"old"}""")
        assertEquals("Thinking", states.last())
        event.invoke(client, """{"type":"output_audio_buffer.started","response_id":"replacement"}""")
        event.invoke(client, """{"type":"output_audio_buffer.stopped","response_id":"old"}""")
        assertEquals("Speaking", states.last())
        event.invoke(client, """{"type":"response.done","response":{"id":"replacement","status":"completed","output":[]}}""")
        assertEquals("Speaking", states.last())
        event.invoke(client, """{"type":"output_audio_buffer.stopped","response_id":"replacement"}""")
        assertEquals("Listening", states.last())
        event.invoke(client, """{"type":"response.created","response":{"id":"tools"}}""")
        event.invoke(client, """{"type":"response.done","response":{"id":"tools","status":"completed","output":[{"type":"function_call","status":"completed","call_id":"call-1","name":"openclaw_agent_consult","arguments":"{}"}]}}""")
        event.invoke(client, """{"type":"output_audio_buffer.stopped","response_id":"tools"}""")
        assertEquals("Thinking", states.last())
      } finally {
        client.close()
        Dispatchers.resetMain()
      }
    }

  @Test
  fun admissionRetainsOnlyPublishedClientResources() =
    runTest {
      Dispatchers.setMain(UnconfinedTestDispatcher(testScheduler))
      try {
        for (accepted in listOf(false, true)) {
          val owner = SupervisorJob()
          val clientScope = CoroutineScope(owner + UnconfinedTestDispatcher(testScheduler))
          val lease = GatewaySession.RequestLease("fixture", requestImpl = { _, _, _, _ -> error("Admission must not allocate a provider session") })
          val client = TalkRealtimeClient(RuntimeEnvironment.getApplication(), clientScope, lease, "main", {}, { _, _, _ -> }, {})
          assertTrue(owner.children.any { it.isActive })
          assertEquals(accepted, client.adopt { accepted })
          runCurrent()
          assertEquals(accepted, owner.children.any { it.isActive })
          assertNull(client.snapshot)
          client.close()
          runCurrent()
          assertFalse(owner.children.any { it.isActive })
          owner.cancel()
        }
      } finally {
        Dispatchers.resetMain()
      }
    }

  @Test
  fun visibleStatusUsesOnlyTheCurrentConfirmedSnapshot() {
    assertEquals(nativeText("Connecting…"), talkRealtimeStatusText("Listening", null))
    val active = TalkRealtimeSnapshot("openai", "gpt-live-1-codex", "oauth", "spruce", "webrtc")
    val nextCall = active.copy(model = "gpt-realtime-2.1", authMethod = "api-key", voice = "alloy")
    val currentText = talkRealtimeStatusText("Thinking", active).resolveNativeText()
    assertTrue(currentText.contains("gpt-live-1-codex / oauth / spruce / webrtc"))
    assertFalse(currentText.contains(nextCall.model!!))
    assertTrue(talkRealtimeStatusText("Listening", nextCall).resolveNativeText().contains("gpt-realtime-2.1 / api-key / alloy / webrtc"))
    assertEquals(nativeText("Connecting…"), talkRealtimeStatusText("Thinking", null))
  }

  @Test
  fun providerVadCompletionArmsCancellationBeforeTheResponseIdArrives() =
    runTest {
      Dispatchers.setMain(UnconfinedTestDispatcher(testScheduler))
      val lease = GatewaySession.RequestLease("fixture", requestImpl = { _, _, _, _ -> error("No gateway allocation expected") })
      val client = TalkRealtimeClient(RuntimeEnvironment.getApplication(), this, lease, "main", {}, { _, _, _ -> }, {})
      try {
        val event = client.javaClass.getDeclaredMethod("handleProviderEvent", String::class.java).apply { isAccessible = true }
        event.invoke(client, """{"type":"input_audio_buffer.speech_stopped"}""")
        val state =
          client.javaClass
            .getDeclaredField("responseState")
            .apply { isAccessible = true }
            .get(client) as TalkRealtimeResponseState
        assertTrue(state.createInFlight)
        assertNull(state.cancel())
        assertEquals("automatic-response", state.created("automatic-response"))
        assertNull(state.cancel())
      } finally {
        client.close()
        Dispatchers.resetMain()
      }
    }

  @Test
  fun requestsGatewayDefaultsAndRejectsAnotherTransportWithoutNativeFallback() =
    runTest {
      Dispatchers.setMain(UnconfinedTestDispatcher(testScheduler))
      try {
        val methods = mutableListOf<String>()
        var createParams = ""
        val lease =
          GatewaySession.RequestLease("fixture", requestImpl = { method, params, _, enqueue ->
            enqueue {}
            methods.add(method)
            if (method == "talk.client.create") {
              createParams = checkNotNull(params)
              """{"voiceSessionId":"voice-fixture","transport":"provider-websocket"}"""
            } else {
              "{}"
            }
          })
        val client = TalkRealtimeClient(RuntimeEnvironment.getApplication(), this, lease, "main", {}, { _, _, _ -> }, {})
        val failure = runCatching { client.start() }.exceptionOrNull()
        assertTrue(failure?.message.orEmpty().contains("unsupported Talk transport"))
        assertEquals(listOf("talk.client.create", "talk.client.close"), methods)
        val params = Json.parseToJsonElement(createParams).jsonObject
        assertEquals("webrtc", params.getValue("transport").jsonPrimitive.content)
        assertFalse(params.containsKey("model"))
        assertFalse(params.containsKey("provider"))
        assertFalse(params.containsKey("authMethod"))
        assertFalse(params.getValue("capabilities").toString().contains("gateway-control-v1"))
      } finally {
        Dispatchers.resetMain()
      }
    }

  @Test
  fun closesAnAllocationReturnedAfterStopWithoutStartingMedia() =
    runTest {
      Dispatchers.setMain(UnconfinedTestDispatcher(testScheduler))
      try {
        val ack = CompletableDeferred<String>()
        val requested = CompletableDeferred<Unit>()
        val methods = mutableListOf<String>()
        val states = mutableListOf<String>()
        val lease =
          GatewaySession.RequestLease("fixture", requestImpl = { method, _, _, enqueue ->
            enqueue {}
            methods.add(method)
            if (method == "talk.client.create") {
              requested.complete(Unit)
              ack.await()
            } else {
              "{}"
            }
          })
        val client = TalkRealtimeClient(RuntimeEnvironment.getApplication(), this, lease, "main", { states.add(it) }, { _, _, _ -> }, {})
        val starting = async { runCatching { client.start() } }
        requested.await()
        client.close()
        ack.complete("""{"voiceSessionId":"voice-late","transport":"webrtc","clientSecret":"synthetic-capability"}""")
        assertTrue(starting.await().isFailure)
        assertEquals(listOf("talk.client.create", "talk.client.close"), methods)
        assertTrue(states.isEmpty())
        assertNull(client.snapshot)
      } finally {
        Dispatchers.resetMain()
      }
    }
}
