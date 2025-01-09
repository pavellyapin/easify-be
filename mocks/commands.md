sam local invoke GenerateCourseQueueFunction --event mocks/course-event.json

sam local invoke GenerateCourseImagesFunction --event mocks/course-imgs-event.json

sam local invoke GenerateWorkoutsBatchFunction --event mocks/workouts-event.json

sam local invoke GenerateRecipesBatchFunction --event mocks/batch-recipes.json

sam local invoke GenerateCareersBatchFunction --event industry-event.json

sam local invoke GenerateFinancialPlansBatchFunction --event mocks/financial-plans-event.json
