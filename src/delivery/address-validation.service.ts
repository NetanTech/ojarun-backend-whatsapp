import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Client, GeocodeResult } from '@googlemaps/google-maps-services-js';

export interface ValidatedAddress {
  original: string;
  formatted: string;
  placeId: string;
  lat: number;
  lng: number;
  isInIbadan: boolean;
  neighborhood?: string;
  landmark?: string;
  fullAddress: string;
}

@Injectable()
export class AddressValidationService {
  private readonly logger = new Logger(AddressValidationService.name);
  private readonly client: Client;
  private readonly apiKey: string;

  // Ibadan boundaries (approximate)
  private readonly IBADAN_BOUNDS = {
    north: 7.4563,
    south: 7.3327,
    east: 3.9543,
    west: 3.8327,
  };

  // Known Ibadan areas/landmarks for quick validation
  private readonly IBADAN_AREAS = new Set([
    'UI', 'UNIVERSITY OF IBADAN',
    'BODIJA', 'SOKA', 'AGODI', 'ALAAFIN',
    'APATA', 'ARMY BARRACKS', 'AWOLOWO AVENUE',
    'BASORUN', 'BENSON IDAHOSA', 'CHALLENGE',
    'DIGI', 'ELEYELE', 'GATE', 'GBAGI',
    'IDI ARO', 'IDI ODO', 'IDI ORI', 'IDI-APE',
    'IKEJA', 'ILORIN ROAD', 'IWOLO', 'JERICHO',
    'LAGOS BYPASS', 'MAGNIFICENT', 'MOKOLA',
    'MONATAN', 'NEW BODIJA', 'OBA ADEYEMI',
    'OBA ILORIN', 'OBA OGUNSINA', 'OBAJANA',
    'OBANIKORO', 'ODA', 'ODO-ONA', 'OGBA',
    'OGUN ROAD', 'OJO', 'OJU IRIN', 'OKE ARE',
    'OKE BOLA', 'OKE ODO', 'OKE ONA', 'OLIYORO',
    'OLOGBO', 'OLUYOLE', 'OMI APATA', 'OMOLE',
    'ONGATA', 'OREBAME', 'OYO ROAD', 'OYO STATE',
    'POLICE HEADQUARTERS', 'QUEEN ELIZABETH ROAD',
    'RING ROAD', 'SABO', 'SALAMI', 'SAMONDA',
    'SEKI', 'TAFAWA BALEWA', 'TANKI', 'UCH',
    'UNIVERSITY COLLEGE HOSPITAL', 'UNIVERSITY OF IBADAN',
    'WEMA BANK', 'YEMETU', 'AKOBO', 'ALALUBOSA',
    'OJA OBA', 'OJA IGBO', 'OJA OBA MARKET',
    'OJA OFA', 'FANTASTIC', 'ONA-ARA', 'AKUFO',
  ]);

  constructor(private readonly config: ConfigService) {
    this.apiKey = this.config.get<string>('google.mapsApiKey') || '';
    this.client = new Client({});
    
    if (!this.apiKey) {
      this.logger.warn('Google Maps API key not configured. Address validation will be limited.');
    }
  }

  async validateAddress(address: string): Promise<ValidatedAddress | null> {
    if (!address || address.trim().length < 3) {
      return null;
    }

    const geocodeResult = await this.geocodeAddress(address);
    if (!geocodeResult) {
      return this.fallbackValidateAddress(address);
    }

    const isInIbadan = this.isInIbadan(geocodeResult);
    const neighborhood = this.extractNeighborhood(geocodeResult, address);

    return {
      original: address,
      formatted: geocodeResult.formatted_address || address,
      placeId: geocodeResult.place_id || '',
      lat: geocodeResult.geometry?.location?.lat || 0,
      lng: geocodeResult.geometry?.location?.lng || 0,
      isInIbadan,
      neighborhood,
      fullAddress: geocodeResult.formatted_address || address,
    };
  }

  private async geocodeAddress(address: string): Promise<GeocodeResult | null> {
    if (!this.apiKey) {
      this.logger.warn('No Google Maps API key available for geocoding');
      return null;
    }

    try {
      const response = await this.client.geocode({
        params: {
          address: `${address}, Ibadan, Oyo State, Nigeria`,
          key: this.apiKey,
          region: 'ng',
          components: {
            country: 'NG',
            administrative_area: 'Oyo',
          },
        },
      });

      if (response.data.status === 'OK' && response.data.results.length > 0) {
        return response.data.results[0];
      }

      if (!address.toLowerCase().includes('ibadan')) {
        const retryResponse = await this.client.geocode({
          params: {
            address: address,
            key: this.apiKey,
            region: 'ng',
          },
        });

        if (retryResponse.data.status === 'OK' && retryResponse.data.results.length > 0) {
          return retryResponse.data.results[0];
        }
      }

      this.logger.warn(`Geocoding failed for address: ${address}, status: ${response.data.status}`);
      return null;
    } catch (error) {
      this.logger.error(`Geocoding error for address ${address}:`, error);
      return null;
    }
  }

  private isInIbadan(result: GeocodeResult): boolean {
    const lat = result.geometry?.location?.lat;
    const lng = result.geometry?.location?.lng;

    if (!lat || !lng) return false;

    const withinBounds = 
      lat >= this.IBADAN_BOUNDS.south && 
      lat <= this.IBADAN_BOUNDS.north &&
      lng >= this.IBADAN_BOUNDS.west && 
      lng <= this.IBADAN_BOUNDS.east;

    if (withinBounds) return true;

    const addressComponents = result.address_components || [];
    const hasIbadan = addressComponents.some(component => 
      component.long_name?.toLowerCase().includes('ibadan') ||
      component.short_name?.toLowerCase().includes('ibadan')
    );

    if (hasIbadan) return true;

    if (result.formatted_address?.toLowerCase().includes('ibadan')) {
      return true;
    }

    return false;
  }

  private extractNeighborhood(result: GeocodeResult, originalAddress: string): string | undefined {
    const components = result.address_components || [];
    
    const neighborhoodTypes = ['neighborhood', 'sublocality', 'sublocality_level_1', 'locality'];
    const administrativeTypes = ['administrative_area_level_1', 'administrative_area_level_2', 'administrative_area_level_3'];
    
    for (const type of neighborhoodTypes) {
      const component = components.find(c => 
        c.types.some(t => t === type)
      );
      if (component && component.long_name) {
        const name = component.long_name;
        if (!['Ibadan', 'Oyo', 'Oyo State', 'Nigeria'].includes(name)) {
          return name;
        }
      }
    }

    for (const type of administrativeTypes) {
      const component = components.find(c => 
        c.types.some(t => t === type)
      );
      if (component && component.long_name) {
        const name = component.long_name;
        if (!['Ibadan', 'Oyo', 'Oyo State', 'Nigeria'].includes(name)) {
          return name;
        }
      }
    }

    const uppercaseAddress = originalAddress.toUpperCase();
    for (const area of this.IBADAN_AREAS) {
      if (uppercaseAddress.includes(area.toUpperCase())) {
        return area;
      }
    }

    const formatted = result.formatted_address || '';
    const parts = formatted.split(',').map(p => p.trim());
    if (parts.length >= 2) {
      const candidate = parts[1];
      if (candidate && !['Ibadan', 'Oyo', 'Oyo State', 'Nigeria'].includes(candidate)) {
        return candidate;
      }
    }

    return undefined;
  }

  private fallbackValidateAddress(address: string): ValidatedAddress | null {
    const uppercaseAddress = address.toUpperCase();
    const hasIbadanArea = Array.from(this.IBADAN_AREAS).some(area => 
      uppercaseAddress.includes(area.toUpperCase())
    );

    const hasIbadan = uppercaseAddress.includes('IBADAN') || 
                     uppercaseAddress.includes('IBADAN,') ||
                     uppercaseAddress.includes('OYO') ||
                     uppercaseAddress.includes('OYO STATE');

    if (!hasIbadan && !hasIbadanArea) {
      return null;
    }

    let neighborhood: string | undefined;
    for (const area of this.IBADAN_AREAS) {
      if (uppercaseAddress.includes(area.toUpperCase())) {
        neighborhood = area;
        break;
      }
    }

    return {
      original: address,
      formatted: address,
      placeId: '',
      lat: 0,
      lng: 0,
      isInIbadan: true,
      neighborhood,
      fullAddress: address,
    };
  }

  async validateAndFormatResponse(address: string): Promise<{
    valid: boolean;
    message: string;
    validatedAddress?: ValidatedAddress;
  }> {
    const validated = await this.validateAddress(address);

    if (!validated) {
      return {
        valid: false,
        message: `Sorry oh, we only deliver within Ibadan for now 📍\n\n` +
                 `Please send your address with a landmark (e.g. "Bodija, near UI gate" or "Soka, Ibadan") so our shoppers fit find you quick quick. 🙏`,
      };
    }

    if (!validated.isInIbadan) {
      return {
        valid: false,
        message: `Sorry oh, we only deliver within Ibadan for now 📍\n\n` +
                 `Your address "${address}" looks like it's outside Ibadan. Please send an Ibadan address with a landmark. 🙏`,
      };
    }

    const locationPart = validated.neighborhood 
      ? `📍 *Delivery to:* ${validated.neighborhood}, Ibadan`
      : `📍 *Delivery to:* ${validated.formatted}`;

    return {
      valid: true,
      message: `Noted! ${locationPart}`,
      validatedAddress: validated,
    };
  }

  quickCheckAddress(address: string): { isInIbadan: boolean; matchedArea?: string } {
    const uppercaseAddress = address.toUpperCase();

    for (const area of this.IBADAN_AREAS) {
      if (uppercaseAddress.includes(area.toUpperCase())) {
        return { isInIbadan: true, matchedArea: area };
      }
    }

    const hasIbadan = uppercaseAddress.includes('IBADAN') || 
                     uppercaseAddress.includes('OYO') ||
                     uppercaseAddress.includes('OYO STATE');

    return { isInIbadan: hasIbadan };
  }

  getKnownAreas(): string[] {
    return Array.from(this.IBADAN_AREAS).sort();
  }

  isKnownIbadanArea(area: string): boolean {
    const upper = area.toUpperCase();
    return Array.from(this.IBADAN_AREAS).some(a => 
      upper.includes(a.toUpperCase()) || a.toUpperCase().includes(upper)
    );
  }
}