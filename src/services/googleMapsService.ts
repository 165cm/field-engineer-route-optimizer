import { LunchInfo, Visit } from "../types";

// Helper to get distances between all points
export async function getDistanceMatrix(
  origins: (string | google.maps.LatLngLiteral)[],
  destinations: (string | google.maps.LatLngLiteral)[]
): Promise<google.maps.DistanceMatrixResponse> {
  const service = new google.maps.DistanceMatrixService();
  return new Promise((resolve, reject) => {
    service.getDistanceMatrix(
      {
        origins,
        destinations,
        travelMode: google.maps.TravelMode.DRIVING,
      },
      (response, status) => {
        if (status === google.maps.DistanceMatrixStatus.OK && response) {
          resolve(response);
        } else {
          reject(status);
        }
      }
    );
  });
}

export async function geocodeAddress(address: string): Promise<google.maps.LatLngLiteral> {
  const geocoder = new google.maps.Geocoder();
  return new Promise((resolve, reject) => {
    geocoder.geocode({ address }, (results, status) => {
      if (status === google.maps.GeocoderStatus.OK && results?.[0]) {
        const loc = results[0].geometry.location;
        resolve({ lat: loc.lat(), lng: loc.lng() });
      } else {
        reject(status);
      }
    });
  });
}

export async function findLunchSpots(
  location: google.maps.LatLngLiteral,
  query: string,
  limit: number = 5,
  icon: string = '🍔'
): Promise<LunchInfo[]> {
  if (!query) return [];

  try {
    const { Place } = (await google.maps.importLibrary("places")) as any;
    const response = await Place.searchByText({
      textQuery: query,
      fields: ['displayName', 'location', 'formattedAddress', 'rating'],
      locationRestriction: {
        north: location.lat + 0.03,
        south: location.lat - 0.03,
        east: location.lng + 0.03,
        west: location.lng - 0.03,
      },
      maxResultCount: limit
    });

    if (!response.places || response.places.length === 0) {
      return [];
    }

    const results: LunchInfo[] = [];

    // Process places sequentially to not blast rate limits for nearbySearch
    for (const place of response.places) {
      const lunchInfo: LunchInfo = {
        name: place.displayName || '昼食',
        address: place.formattedAddress || '',
        rating: place.rating || undefined,
        location: place.location ? { lat: place.location.lat(), lng: place.location.lng() } : undefined,
        type: query,
        icon: icon
      };

      if (place.location) {
        try {
          const parkingResponse = await Place.searchNearby({
            fields: ['displayName'],
            locationRestriction: {
              center: place.location,
              radius: 150
            },
            includedTypes: ['parking']
          });

          if (parkingResponse.places && parkingResponse.places.length > 0) {
            lunchInfo.hasParkingNear = true;
          } else {
            lunchInfo.hasParkingNear = false;
          }
        } catch (parkingErr) {
          console.warn("Parking search failed:", parkingErr);
          lunchInfo.hasParkingNear = false;
        }
      }

      results.push(lunchInfo);
    }
    
    return results;
  } catch (error) {
    console.error("Places API Error:", error);
    return [];
  }
}
