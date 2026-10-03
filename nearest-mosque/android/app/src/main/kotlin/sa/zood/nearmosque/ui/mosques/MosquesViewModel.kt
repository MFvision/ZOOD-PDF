package sa.zood.nearmosque.ui.mosques

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import sa.zood.nearmosque.AppContainer
import sa.zood.nearmosque.core.LatLng
import sa.zood.nearmosque.core.Mosque
import sa.zood.nearmosque.core.SearchGeneration
import sa.zood.nearmosque.data.MosqueResult
import sa.zood.nearmosque.platform.LocationPermission

/** Where the list is measured from. Selecting a point never moves "you are here". */
sealed interface SearchOrigin {
    data object Device : SearchOrigin
    data class PrayerCity(val name: String) : SearchOrigin
    data object SelectedPoint : SearchOrigin
}

data class MosquesUi(
    val origin: SearchOrigin? = null,
    val center: LatLng? = null,
    val loading: Boolean = false,
    val result: MosqueResult? = null,
    val favorites: Set<String> = emptySet(),
    val favoritesOnly: Boolean = false,
    val favoriteMosques: List<Mosque> = emptyList(),
    val permissionDenied: Boolean = false,
    val locating: Boolean = false,
)

class MosquesViewModel(private val c: AppContainer) : ViewModel() {
    private val generation = SearchGeneration()
    private var job: Job? = null
    private val _ui = MutableStateFlow(MosquesUi())

    val ui: StateFlow<MosquesUi> = combine(_ui, c.mosques.favorites) { u, fav -> u.copy(favorites = fav) }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), MosquesUi())
    val device = c.devicePosition.asStateFlow()

    /** Initial origin: the device if a fix exists, otherwise the prayer city; never a default city. */
    fun start(lang: String) = viewModelScope.launch {
        if (_ui.value.center != null) return@launch
        val pos = c.devicePosition.value
        if (pos != null) { search(pos.location, SearchOrigin.Device, lang); return@launch }
        val loc = c.settings.settings.first().prayerLocation
        if (loc != null) search(loc.location, SearchOrigin.PrayerCity(loc.name), lang)
    }

    fun useDevice(lang: String) = viewModelScope.launch {
        if (c.location.permission() == LocationPermission.DENIED) {
            _ui.value = _ui.value.copy(permissionDenied = true); return@launch
        }
        _ui.value = _ui.value.copy(locating = true, permissionDenied = false)
        val fix = c.location.currentPosition() ?: c.location.lastKnown(30 * 60_000L)
        _ui.value = _ui.value.copy(locating = false)
        if (fix != null) {
            c.devicePosition.value = fix
            search(fix.location, SearchOrigin.Device, lang)
        }
    }

    fun usePrayerCity(lang: String) = viewModelScope.launch {
        c.settings.settings.first().prayerLocation?.let { search(it.location, SearchOrigin.PrayerCity(it.name), lang) }
    }

    fun searchAt(point: LatLng, lang: String) = search(point, SearchOrigin.SelectedPoint, lang)

    fun setFavoritesOnly(on: Boolean) = viewModelScope.launch {
        val favs = if (on) c.mosques.byIds(ui.value.favorites) else emptyList()
        _ui.value = _ui.value.copy(favoritesOnly = on, favoriteMosques = favs)
    }

    fun toggleFavorite(id: String) = viewModelScope.launch {
        c.mosques.setFavorite(id, id !in ui.value.favorites)
    }

    /** Cancels any search in flight; a slower, older result can never overwrite a newer one. */
    fun search(center: LatLng, origin: SearchOrigin, lang: String) {
        val gen = generation.next()
        job?.cancel()
        _ui.value = _ui.value.copy(origin = origin, center = center, loading = true)
        job = viewModelScope.launch {
            val r = c.mosques.nearest(center, RADIUS_M, lang)
            if (generation.isCurrent(gen)) _ui.value = _ui.value.copy(result = r, loading = false)
        }
    }

    companion object {
        const val RADIUS_M = 25_000.0
    }
}
