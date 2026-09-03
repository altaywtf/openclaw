package ai.openclaw.app.chat

import androidx.room3.Dao
import androidx.room3.Entity
import androidx.room3.Insert
import androidx.room3.OnConflictStrategy
import androidx.room3.Query

internal data class ChatReaderPosition(
  val messageId: String?,
  val itemIndex: Int,
  val itemOffset: Int,
  val messageVersion: String? = null,
)

@Entity(tableName = "chat_reader_positions", primaryKeys = ["gatewayId", "sessionKey"])
internal data class ChatReaderPositionEntity(
  val gatewayId: String,
  val sessionKey: String,
  val messageId: String?,
  val itemIndex: Int,
  val itemOffset: Int,
  val messageVersion: String?,
)

@Dao
internal interface ChatReaderPositionDao {
  @Query("SELECT * FROM chat_reader_positions WHERE gatewayId = :gatewayId AND sessionKey = :sessionKey")
  suspend fun load(
    gatewayId: String,
    sessionKey: String,
  ): ChatReaderPositionEntity?

  @Insert(onConflict = OnConflictStrategy.REPLACE)
  suspend fun upsert(position: ChatReaderPositionEntity)

  @Query("DELETE FROM chat_reader_positions WHERE gatewayId = :gatewayId AND sessionKey = :sessionKey")
  suspend fun deleteSession(
    gatewayId: String,
    sessionKey: String,
  )

  @Query("DELETE FROM chat_reader_positions WHERE gatewayId = :gatewayId")
  suspend fun clearGateway(gatewayId: String)
}

internal class ChatReaderPositionStore(
  private val database: suspend () -> ClientStateDatabase,
) {
  suspend fun load(
    gatewayId: String,
    sessionKey: String,
  ): ChatReaderPosition? =
    database()
      .readerPositionDao()
      .load(gatewayId, sessionKey)
      ?.let { ChatReaderPosition(it.messageId, it.itemIndex, it.itemOffset, it.messageVersion) }

  suspend fun save(
    gatewayId: String,
    sessionKey: String,
    position: ChatReaderPosition,
  ) {
    database()
      .readerPositionDao()
      .upsert(
        ChatReaderPositionEntity(
          gatewayId = gatewayId,
          sessionKey = sessionKey,
          messageId = position.messageId,
          itemIndex = position.itemIndex,
          itemOffset = position.itemOffset,
          messageVersion = position.messageVersion,
        ),
      )
  }

  suspend fun deleteSession(
    gatewayId: String,
    sessionKey: String,
  ) = database().readerPositionDao().deleteSession(gatewayId, sessionKey)

  suspend fun clearGateway(gatewayId: String) = database().readerPositionDao().clearGateway(gatewayId)
}
