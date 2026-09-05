package ai.openclaw.app.wear

import ai.openclaw.wear.shared.WearMessage
import ai.openclaw.wear.shared.WearProxyCapability
import ai.openclaw.wear.shared.WearRpcMethod
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class WearProxyModelCatalogTest {
  @Test
  fun watchSessionUsesItsPublishedProfileInsteadOfThePhoneSession() =
    runTest {
      val watchSession = "agent:main:watch-a"
      val phoneSession = "agent:main:phone-b"
      val gatewayRequests = mutableListOf<Pair<String, JsonObject>>()
      val selections = mutableListOf<Pair<String, String>>()
      val controller =
        WearProxyController(
          requestGateway = { method, params ->
            gatewayRequests += method to params
            val watchProfile = params["sessionKey"]?.jsonPrimitive?.content == watchSession
            Json.parseToJsonElement(
              """{"models":[{"id":"model-a","name":"Model A","provider":"synthetic","available":$watchProfile},{"id":"model-b","name":"Model B","provider":"synthetic","available":${!watchProfile}}]}""",
            )
          },
          isGatewayConnected = { true },
          gatewayStatusText = { "Connected" },
          hasOperatorAdminScope = { true },
          supportsSessionModelCatalog = { true },
          activeSessionKey = { phoneSession },
          selectedModelRef = { "synthetic/model-b" },
          models = { listOf(WearProxyModel("synthetic/model-b", "Model B")) },
          selectSessionModel = { sessionKey, modelRef ->
            selections += sessionKey to modelRef
            sessionKey == watchSession && modelRef == "synthetic/model-a"
          },
        )

      val legacy = controller.handle(WearMessage.Request(requestId = "legacy", method = WearRpcMethod.ModelsList))
      assertEquals(listOf("synthetic/model-b"), modelRefs(legacy))
      assertTrue(gatewayRequests.isEmpty())

      val scoped =
        controller.handle(
          WearMessage.Request(
            requestId = "watch-a",
            method = WearRpcMethod.ModelsList,
            params = buildJsonObject { put("sessionKey", " $watchSession ") },
          ),
        )

      assertTrue(scoped.ok)
      assertEquals(listOf("synthetic/model-a"), modelRefs(scoped))
      assertEquals(
        listOf(
          "models.list" to buildJsonObject {
            put("sessionKey", watchSession)
            put("view", "configured")
          },
        ),
        gatewayRequests,
      )
      val selected =
        controller.handle(
          WearMessage.Request(
            requestId = "select-watch-a",
            method = WearRpcMethod.ModelsSelect,
            params = buildJsonObject {
              put("sessionKey", watchSession)
              put("modelRef", "synthetic/model-a")
            },
          ),
        )
      assertTrue(selected.ok)
      assertEquals(listOf(watchSession to "synthetic/model-a"), selections)
    }

  @Test
  fun unsupportedScopedReadNeverFallsBackToThePhoneCatalog() =
    runTest {
      var legacyReads = 0
      var gatewayReads = 0
      val controller =
        WearProxyController(
          requestGateway = { _, _ ->
            gatewayReads += 1
            buildJsonObject {}
          },
          isGatewayConnected = { true },
          gatewayStatusText = { "Connected" },
          hasOperatorAdminScope = { true },
          models = {
            legacyReads += 1
            listOf(WearProxyModel("synthetic/phone-model", "Phone model"))
          },
        )
      val status = controller.handle(WearMessage.Request(requestId = "status", method = WearRpcMethod.ProxyStatus))
      val capabilities = checkNotNull(status.result).jsonObject.getValue("capabilities").jsonArray.map { it.jsonPrimitive.content }
      assertFalse(WearProxyCapability.SessionScopedModelCatalog.wireValue in capabilities)

      val result =
        controller.handle(
          WearMessage.Request(
            requestId = "unsupported",
            method = WearRpcMethod.ModelsList,
            params = buildJsonObject { put("sessionKey", "agent:main:watch-a") },
          ),
        )

      assertFalse(result.ok)
      assertEquals("unsupported_peer", result.error?.code)
      assertEquals(0, legacyReads)
      assertEquals(0, gatewayReads)
    }

  @Test
  fun scopedCatalogRequestFailureDoesNotBecomeAnEmptyOrPhoneCurrentList() =
    runTest {
      var legacyReads = 0
      var gatewayReads = 0
      val controller =
        WearProxyController(
          requestGateway = { _, _ ->
            gatewayReads += 1
            throw WearProxyGatewayException("unavailable", "Catalog request failed")
          },
          isGatewayConnected = { true },
          gatewayStatusText = { "Connected" },
          supportsSessionModelCatalog = { true },
          models = {
            legacyReads += 1
            listOf(WearProxyModel("synthetic/phone-model", "Phone model"))
          },
        )
      val result =
        controller.handle(
          WearMessage.Request(
            requestId = "failed",
            method = WearRpcMethod.ModelsList,
            params = buildJsonObject { put("sessionKey", "agent:main:watch-a") },
          ),
        )

      assertFalse(result.ok)
      assertEquals("unavailable", result.error?.code)
      assertEquals("Catalog request failed", result.error?.message)
      assertEquals(1, gatewayReads)
      assertEquals(0, legacyReads)
    }

  @Test
  fun completedScopedRefreshFailureKeepsHealthyChoicesAndCurrentAccess() =
    runTest {
      var legacyReads = 0
      val controller =
        WearProxyController(
          requestGateway = { _, _ ->
            Json.parseToJsonElement(
              """{"models":[{"id":"healthy","name":"Healthy","provider":"synthetic","available":true},{"id":"restricted","name":"Restricted","provider":"synthetic","available":false}],"refreshFailed":true}""",
            )
          },
          isGatewayConnected = { true },
          gatewayStatusText = { "Connected" },
          supportsSessionModelCatalog = { true },
          models = {
            legacyReads += 1
            listOf(WearProxyModel("synthetic/phone-model", "Phone model"))
          },
        )

      for (query in listOf(null, "healthy", "restricted")) {
        val result =
          controller.handle(
            WearMessage.Request(
              requestId = "published",
              method = WearRpcMethod.ModelsList,
              params = buildJsonObject {
                put("sessionKey", "agent:main:watch-a")
                query?.let { put("query", it) }
              },
            ),
          )

        assertTrue(result.ok)
        assertEquals(if (query == "restricted") emptyList<String>() else listOf("synthetic/healthy"), modelRefs(result))
        assertTrue(checkNotNull(result.result).jsonObject.getValue("refreshFailed").jsonPrimitive.boolean)
      }
      assertEquals(0, legacyReads)
    }

  private fun modelRefs(response: WearMessage.Response): List<String> =
    checkNotNull(response.result)
      .jsonObject
      .getValue("models")
      .jsonArray
      .map { it.jsonObject.getValue("ref").jsonPrimitive.content }
}
