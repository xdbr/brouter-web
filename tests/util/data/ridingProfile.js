// A small profile exercising the supported gravel expression shapes.
module.exports = `
---context:global
assign validForBikes = true
assign prefer_unpaved_paths = false # %prefer_unpaved_paths% | Unpaved | boolean
assign prefer_forests = false # %prefer_forests% | Forest | boolean
assign prefer_rivers = false # %prefer_rivers% | Water | boolean
assign avoid_noise = false # %avoid_noise% | Noise | boolean
assign bikerPower = 150 # %bikerPower% | Power | number
---context:way
assign noforestpenalty switch prefer_forests 2.5 1
assign noriverpenalty switch prefer_rivers 3.15 1
assign noisepenalty switch avoid_noise 2.2 1
assign tracktypepenalty
 switch tracktype=grade1 switch not prefer_unpaved_paths 1.0 1.1
 switch tracktype=grade2 switch not prefer_unpaved_paths 1.1 1.0 1
assign initialcost multiply 20 ( switch and prefer_unpaved_paths is_paved 2 1 )
assign smoothnesspenalty multiply 1.2 ( switch and prefer_unpaved_paths is_paved 2 1 )
assign smoothnesspenalty max 1 multiply smoothnesspenalty ( switch and prefer_unpaved_paths ( lesser smoothnesspenalty 1.6 ) 0.84 1 )
assign costfactor multiply noforestpenalty multiply noriverpenalty multiply noisepenalty smoothnesspenalty
---context:node
assign initialcost 0
`;
