package ai.openclaw.app.voice

import kotlinx.coroutines.CompletableDeferred
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class TalkRealtimeTranscriptOrderTest {
  @Test fun assistantFinalWaitsBehindDelayedUserFinal() {
    val ordered = mutableListOf<Triple<String, String, CompletableDeferred<String?>>>()
    val owner = TalkRealtimeTranscriptOrder { _, role, entryId, text -> ordered += Triple(role, entryId, text) }
    assertTrue(owner.reserve("u1", null, "user"))
    assertTrue(owner.reserve("a1", "u1", "assistant"))
    assertTrue(owner.settle("a1", "assistant", "answer"))
    assertEquals(listOf("user", "assistant"), ordered.map { it.first })
    assertEquals(listOf("1", "2"), ordered.map { it.second })
    assertFalse(ordered[0].third.isCompleted)
    assertTrue(ordered[1].third.isCompleted)
    assertTrue(owner.settle("u1", "user", "question"))
    assertTrue(ordered[0].third.isCompleted)
  }

  @Test fun failedOrEmptyPredecessorSettlesAndOverflowRejects() {
    val ordered = mutableListOf<CompletableDeferred<String?>>()
    val owner = TalkRealtimeTranscriptOrder(maxItems = 3, maxSpeechItems = 2) { _, _, _, text -> ordered += text }
    assertTrue(owner.reserve("u1", null, "user"))
    assertTrue(owner.reserve("tool", "u1", null))
    assertTrue(owner.reserve("a1", "tool", "assistant"))
    assertFalse(owner.reserve("overflow", "a1", "assistant"))
    assertTrue(owner.settle("u1"))
    assertTrue(owner.settle("a1", "assistant", "answer"))
    assertEquals(null, ordered[0].getCompleted())
    assertEquals("answer", ordered[1].getCompleted())
  }

  @Test fun outOfOrderAnnouncementsWaitForTheirPredecessor() {
    val order = mutableListOf<String>()
    val owner = TalkRealtimeTranscriptOrder { itemId, _, _, _ -> order += itemId }
    assertTrue(owner.reserve("a1", "u1", "assistant"))
    assertTrue(order.isEmpty())
    assertTrue(owner.reserve("u1", null, "user"))
    assertEquals(listOf("u1", "a1"), order)
  }
}
