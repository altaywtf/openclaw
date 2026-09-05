package ai.openclaw.app.voice

import android.content.Context
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Looper
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.AudioDeviceInfoBuilder
import org.robolectric.util.ReflectionHelpers
import org.webrtc.audio.JavaAudioDeviceModule

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class TalkRealtimePeerAudioTest {
  @Test fun pauseResumeAndCloseOwnFocusWithoutAllocatingANativeCall() =
    runTest {
      Dispatchers.setMain(UnconfinedTestDispatcher(testScheduler))
      val context = RuntimeEnvironment.getApplication()
      val manager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
      val failures = mutableListOf<String>()
      val peer = TalkRealtimePeer(context, this, {}, { failures.add(it) })
      try {
        peer.setCaptureEnabled(false)
        peer.setPlaybackEnabled(false)
        // The Java module can be configured before JNI allocation; this exercises the
        // real peer toggle path without making a provider call or creating a recorder.
        ReflectionHelpers.setField(peer, "audioDevice", JavaAudioDeviceModule.builder(context).createAudioDeviceModule())
        peer.setCaptureEnabled(true)
        assertEquals(AudioManager.MODE_IN_COMMUNICATION, manager.mode)
        val first = shadowOf(manager).lastAudioFocusRequest.audioFocusRequest
        peer.setCaptureEnabled(false)
        assertEquals(AudioManager.MODE_NORMAL, manager.mode)
        peer.setPlaybackEnabled(true)
        assertEquals(AudioManager.MODE_IN_COMMUNICATION, manager.mode)
        assertNotSame(first, shadowOf(manager).lastAudioFocusRequest.audioFocusRequest)
        peer.close()
        assertEquals(AudioManager.MODE_NORMAL, manager.mode)
        peer.setPlaybackEnabled(true)
        assertEquals(AudioManager.MODE_NORMAL, manager.mode)
        assertTrue(failures.isEmpty())
      } finally {
        peer.close()
        Dispatchers.resetMain()
      }
    }

  @Test fun lostSelectedInputEndsTheCallRatherThanCallingTheSdkWithNull() =
    runTest {
      Dispatchers.setMain(UnconfinedTestDispatcher(testScheduler))
      val context = RuntimeEnvironment.getApplication()
      val manager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
      val device = AudioDeviceInfoBuilder.newBuilder().setType(AudioDeviceInfo.TYPE_USB_DEVICE).build()
      shadowOf(manager).setInputDevices(listOf(device))
      val failures = mutableListOf<String>()
      val requested = mutableListOf<String?>()
      val peer = TalkRealtimePeer(context, this, {}, { failures.add(it) }, { audioInputDeviceKey(device) }, { requested.add(it) })
      try {
        peer.setCaptureEnabled(false)
        peer.setPlaybackEnabled(false)
        ReflectionHelpers.setField(peer, "audioDevice", JavaAudioDeviceModule.builder(context).createAudioDeviceModule())
        ReflectionHelpers.setField(peer, "selectedAudioInputKey", audioInputDeviceKey(device))
        peer.setCaptureEnabled(true)
        assertEquals(audioInputDeviceKey(device), requested.last())
        shadowOf(manager).removeInputDevice(device, true)
        shadowOf(Looper.getMainLooper()).idle()
        assertEquals(listOf("Realtime microphone route changed; restart Talk to use automatic input"), failures)
        assertTrue(requested.all { it == audioInputDeviceKey(device) })
        assertEquals(AudioManager.MODE_NORMAL, manager.mode)
      } finally {
        peer.close()
        shadowOf(manager).setInputDevices(emptyList())
        Dispatchers.resetMain()
      }
    }

  @Test fun refusedFocusOnResumeReportsFailureRatherThanSilentlyStalling() =
    runTest {
      Dispatchers.setMain(UnconfinedTestDispatcher(testScheduler))
      val context = RuntimeEnvironment.getApplication()
      val manager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
      val failures = mutableListOf<String>()
      val peer = TalkRealtimePeer(context, this, {}, { failures.add(it) })
      try {
        peer.setCaptureEnabled(false)
        peer.setPlaybackEnabled(false)
        ReflectionHelpers.setField(peer, "audioDevice", JavaAudioDeviceModule.builder(context).createAudioDeviceModule())
        shadowOf(manager).setNextFocusRequestResponse(AudioManager.AUDIOFOCUS_REQUEST_FAILED)
        peer.setCaptureEnabled(true)
        assertEquals(listOf("Realtime audio routing or focus unavailable"), failures)
        assertEquals(AudioManager.MODE_NORMAL, manager.mode)
      } finally {
        peer.close()
        Dispatchers.resetMain()
      }
    }
}
