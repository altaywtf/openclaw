package ai.openclaw.app.voice

import kotlinx.coroutines.CompletableDeferred
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class TalkRealtimeTranscriptOrderTest {
  @Test fun assistantFinalWaitsBehindDelayedUserFinal() {
    val ordered = mutableListOf<Triple<String, CompletableDeferred<String>, CompletableDeferred<String?>>>()
    val owner = TalkRealtimeTranscriptOrder { _, role, entryId, text, _, _ -> ordered += Triple(role, entryId, text) }
    assertTrue(owner.reserve("u1", null, "user"))
    assertTrue(owner.reserve("a1", "u1", "assistant"))
    assertTrue(owner.settle("a1", "assistant", "answer"))
    assertEquals(listOf("user", "assistant"), ordered.map { it.first })
    assertEquals(listOf("1", "2"), ordered.map { it.second.getCompleted() })
    assertFalse(ordered[0].third.isCompleted)
    assertTrue(ordered[1].third.isCompleted)
    assertTrue(owner.settle("u1", "user", "question"))
    assertTrue(ordered[0].third.isCompleted)
  }

  @Test fun failedOrEmptyPredecessorSettlesAndOverflowRejects() {
    val ordered = mutableListOf<CompletableDeferred<String?>>()
    val owner = TalkRealtimeTranscriptOrder(maxItems = 3, maxSpeechItems = 2) { _, _, _, text, _, _ -> ordered += text }
    assertTrue(owner.reserve("u1", null, "user"))
    assertTrue(owner.reserve("tool", "u1", null))
    assertTrue(owner.reserve("a1", "tool", "assistant"))
    assertFalse(owner.reserve("overflow", "a1", "assistant"))
    assertTrue(owner.settle("u1"))
    assertTrue(owner.settle("a1", "assistant", "answer"))
    assertEquals(null, ordered[0].getCompleted())
    assertEquals("answer", ordered[1].getCompleted())
  }

  @Test fun completedSpeechReservationsReleaseCapacity() {
    val writes = mutableMapOf<String, CompletableDeferred<Unit>>()
    val owner =
      TalkRealtimeTranscriptOrder(maxItems = 2, maxSpeechItems = 1) { itemId, _, _, _, _, written ->
        writes[itemId] = written
      }
    assertTrue(owner.reserve("u1", null, "user"))
    writes.getValue("u1").complete(Unit)
    owner.release("u1")
    assertTrue(owner.reserve("u2", "u1", "user"))
  }

  @Test fun orderedNonSpeechAncestryDoesNotConsumeCapacity() {
    val owner = TalkRealtimeTranscriptOrder(maxItems = 1) { _, _, _, _, _, _ -> }
    var previous: String? = null
    repeat(10) { index ->
      val id = "tool-$index"
      assertTrue(owner.reserve(id, previous, null))
      previous = id
    }
  }

  @Test fun outOfOrderAnnouncementsWaitForTheirPredecessor() {
    val order = mutableMapOf<String, CompletableDeferred<String>>()
    val owner = TalkRealtimeTranscriptOrder { itemId, _, entryId, _, _, _ -> order[itemId] = entryId }
    assertTrue(owner.reserve("a1", "u1", "assistant"))
    assertFalse(order.getValue("a1").isCompleted)
    assertTrue(owner.reserve("u1", null, "user"))
    assertEquals("1", order.getValue("u1").getCompleted())
    assertEquals("2", order.getValue("a1").getCompleted())
  }
}
