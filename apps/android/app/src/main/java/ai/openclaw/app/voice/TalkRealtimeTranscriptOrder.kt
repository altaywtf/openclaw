package ai.openclaw.app.voice

import kotlinx.coroutines.CompletableDeferred

internal class TalkRealtimeTranscriptOrder(
  private val maxItems: Int = 1024,
  private val maxSpeechItems: Int = 128,
  private val onOrdered: (itemId: String, role: String, entryId: String, text: CompletableDeferred<String?>) -> Unit,
) {
  private data class Item(
    val previousItemId: String?,
    val role: String?,
    val text: CompletableDeferred<String?> = CompletableDeferred(),
    var ordered: Boolean = false,
  )

  private val items = linkedMapOf<String, Item>()
  private var lastItemId: String? = null
  private var sequence = 0
  private var speechItems = 0

  fun reserve(
    itemId: String,
    previousItemId: String?,
    role: String?,
  ): Boolean {
    if (itemId in items) return true
    if (items.size >= maxItems) return false
    if (role != null && speechItems >= maxSpeechItems) return false
    if (role != null) speechItems++
    items[itemId] = Item(previousItemId, role)
    assignOrders()
    return true
  }

  fun settle(
    itemId: String,
    role: String,
    text: String?,
  ): Boolean {
    val item = items[itemId] ?: return false
    if (item.role != role || item.text.isCompleted) return false
    item.text.complete(text?.takeIf(String::isNotEmpty))
    return true
  }

  fun settle(itemId: String): Boolean {
    val item = items[itemId] ?: return false
    if (item.text.isCompleted) return false
    item.text.complete(null)
    return true
  }

  fun close() {
    items.values.forEach { if (!it.text.isCompleted) it.text.complete(null) }
  }

  private fun assignOrders() {
    while (true) {
      val next =
        items.entries.firstOrNull { (_, item) ->
          !item.ordered &&
            (if (item.previousItemId == null) lastItemId == null else item.previousItemId == lastItemId)
        } ?: return
      val (itemId, item) = next
      item.ordered = true
      lastItemId = itemId
      if (item.role != null) {
        onOrdered(itemId, item.role, (++sequence).toString(), item.text)
      }
    }
  }
}
