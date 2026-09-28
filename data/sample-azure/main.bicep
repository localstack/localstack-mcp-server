// A deployment for the Docker harness's Bicep checks (plan task 5.4, decision D11). It
// creates one user-assigned identity named by the parameter, so the check can see that
// Bicep compiled the file, the parameter arrived and the resource exists. (The emulator
// returns no deployment outputs, so an output alone would prove nothing.)
param identityName string
param location string = 'westeurope'

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: identityName
  location: location
}
