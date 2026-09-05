package ai.openclaw.app

import ai.openclaw.app.gateway.GatewayRequestRejected
import ai.openclaw.app.gateway.GatewaySession
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class ProviderModelCatalogRequestTest {
  @Test
  fun modelCatalogDistinguishesEmptyPublicationFromRefreshFailure() {
    val empty = parseGatewayModelCatalog(Json.parseToJsonElement("""{"models":[]}""") as kotlinx.serialization.json.JsonObject)
    val failed = parseGatewayModelCatalog(Json.parseToJsonElement("""{"models":[],"refreshFailed":true}""") as kotlinx.serialization.json.JsonObject)

    assertTrue(empty.models.isEmpty())
    assertEquals(false, empty.refreshFailed)
    assertTrue(failed.models.isEmpty())
    assertEquals(true, failed.refreshFailed)
  }

  @Test
  fun discoveryRequiresAnExplicitRefreshForTheSelectedAgent() =
    runBlocking {
      val requests = mutableListOf<String>()
      requestProviderModelConfig(agentId = "worker") { params ->
        requests += params
        """{"models":[]}"""
      }
      requestProviderModelConfig(agentId = "worker", refresh = true) { params ->
        requests += params
        """{"models":[]}"""
      }

      assertEquals(
        listOf(
          """{"view":"provider-config","agentId":"worker"}""",
          """{"view":"provider-config","agentId":"worker","refresh":true}""",
        ),
        requests,
      )
    }

  @Test
  fun prefersEffectiveContextCapOverNativeWindow() {
    val models =
      parseGatewayModels(
        Json
          .parseToJsonElement(
            """[{"id":"model","name":"Model","provider":"example","contextWindow":128000,"contextTokens":96000}]""",
          ).jsonArray,
      )

    assertEquals(96_000L, models.single().contextTokens)
  }

  @Test
  fun preservesKnownAvailabilityReasonsAndFailsOpenForUnknownReasons() {
    val models =
      parseGatewayModels(
        Json
          .parseToJsonElement(
            """
            [
              {"id":"missing","provider":"synthetic","available":false,"unavailableReason":"missing-auth"},
              {"id":"failed","provider":"synthetic","available":false,"unavailableReason":"auth-failed"},
              {"id":"cooling","provider":"synthetic","available":false,"unavailableReason":"cooldown"},
              {"id":"future","provider":"synthetic","available":false,"unavailableReason":"future-reason"}
            ]
            """.trimIndent(),
          ).jsonArray,
      )

    assertEquals(GatewayModelUnavailableReason.MissingAuth, models[0].unavailableReason)
    assertEquals(GatewayModelUnavailableReason.AuthFailed, models[1].unavailableReason)
    assertEquals(GatewayModelUnavailableReason.Cooldown, models[2].unavailableReason)
    assertEquals(null, models[3].unavailableReason)
  }

  @Test
  fun reportsProviderConfigUnsupportedWithoutSubstitutingConfiguredView() =
    runBlocking {
      val requests = mutableListOf<String>()
      var actual: Throwable? = null

      try {
        requestProviderModelConfig { paramsJson ->
          requests += paramsJson
          throw GatewayRequestRejected(GatewaySession.ErrorShape("INVALID_REQUEST", "unsupported view"))
        }
      } catch (err: Throwable) {
        actual = err
      }

      assertTrue(actual is ProviderModelConfigUnsupported)
      assertEquals(listOf("""{"view":"provider-config"}"""), requests)
    }

  @Test
  fun preservesNonCompatibilityGatewayFailures() =
    runBlocking {
      val expected = GatewayRequestRejected(GatewaySession.ErrorShape("UNAVAILABLE", "gateway busy"))
      var actual: Throwable? = null

      try {
        requestProviderModelConfig { throw expected }
      } catch (err: Throwable) {
        actual = err
      }

      assertSame(expected, actual)
    }
}
