// Compatibility export for integrations using the original launcher utility.
// The execution host now owns the instance so drain and refresh have one writer.
export { startNacosRegistration, type NacosRegistration, type NacosRegistrationOptions } from '../../../shared/nacos-registration.ts'
